import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import type { Config, Subtask, WorkUnit } from '../../src/core/types.js';
import type { ExecutorAdapter, ExecutorInput } from '../../src/executor/adapter.js';
import type { LlmBridge } from '../../src/core/llm-bridge.js';
import type { IntentDecisionV2 } from '../../src/core/intent-orchestrator.js';
import type { QueuedExecutionRequest } from '../../src/session/session-helpers.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: { command: 'codex', timeout: 60_000 },
    orchestration: { reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5 },
    ui: { language: 'zh-CN', dashboard_on_start: false },
  };
}

function createHarness(input: {
  executor: ExecutorAdapter;
  db?: Database.Database;
  sessionId?: string;
}) {
  const db = input.db ?? createDb();
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-planner-work-unit-bugfix');
  const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
  const session = new MetaclawSession({
    taskEngine,
    memoryEngine,
    orchestration: new OrchestrationEngine(taskEngine),
    executor: input.executor,
    db,
    config: createConfig(),
    sessionId: input.sessionId ?? 'sess_planner_work_unit_bugfix',
    contextRecaller: new ContextRecaller(db),
    llmBridge: {
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: 'durable task' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: 'new task' }),
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge,
    availableExecutorCommands: new Set(['codex']),
  });
  session.initialize();
  return { db, taskRepo, taskEngine, session, subtaskRepo: new SubtaskRepo(db), workUnitRepo: new WorkUnitRepo(db) };
}

function createExecutor(
  execute: (input: ExecutorInput) => Promise<{ success: boolean; output: string; error?: string; exitCode: number; durationMs: number }>,
): ExecutorAdapter {
  return {
    name: 'codex-cli',
    execute: vi.fn().mockImplementation(execute),
    isAvailable: vi.fn().mockResolvedValue(true),
    abort: vi.fn(),
  };
}

function readyTask(taskEngine: TaskEngine, title = 'planner work unit task') {
  const task = taskEngine.create({ title, goal: title });
  taskEngine.transition(task.id, 'ready');
  return task;
}

function request(taskId: string, userPrompt = 'execute task', intentDecision: IntentDecisionV2 | null = null): QueuedExecutionRequest {
  return {
    userPrompt,
    contextTaskId: taskId,
    executionMode: 'fresh',
    intentDecision,
    includeRecentConversationContext: false,
  };
}

function subtask(input: Partial<Subtask> & { id: string; taskId: string; title: string }): Subtask {
  return {
    goal: input.title,
    status: 'ready',
    dependsOn: [],
    requiredAgentClassKind: 'executor',
    agentClassHint: 'codex-cli',
    candidateAgentClasses: ['codex-cli'],
    expectedOutput: 'summary',
    acceptance: [],
    riskLevel: 'medium',
    result: '',
    error: null,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...input,
  };
}

async function dispatchExistingTask(
  harness: ReturnType<typeof createHarness>,
  taskId: string,
  queuedRequest: QueuedExecutionRequest = request(taskId),
) {
  await (harness.session as any).scheduler.submit(taskId, {
    reason: 'test dispatch',
    executionRequest: queuedRequest,
  });
  await harness.session.waitForAsyncWork();
}

function directReplyIntent(): IntentDecisionV2 {
  return {
    interactionType: 'direct_reply',
    confidence: 0.9,
    reason: 'answer directly',
    clarificationQuestion: null,
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    task: { binding: 'none', taskId: null, control: 'none', scope: null },
    execution: {
      mode: 'single_executor',
      complexity: 'simple',
      selectedExecutor: 'codex-cli',
      candidateExecutors: ['codex-cli'],
      requiresVerification: false,
      canModifyFiles: false,
      requiresExternalGateway: false,
      capabilityClass: 'general',
      primaryIntent: 'general',
      matchedBoundary: [],
    },
    hints: [],
  };
}

describe('planner/work-unit active path regressions', () => {
  it('recovers a persisted running subtask to ready and executes it instead of false-successing', async () => {
    const executor = createExecutor(async () => ({ success: true, output: 'resumed subtask done', exitCode: 0, durationMs: 10 }));
    const harness = createHarness({ executor, sessionId: 'sess_resume_running_subtask' });
    const task = readyTask(harness.taskEngine, 'resume running subtask');
    harness.subtaskRepo.upsert(subtask({
      id: `${task.id}_subtask_running`,
      taskId: task.id,
      title: 'running subtask',
      status: 'running',
      error: 'previous timeout',
    }));

    await dispatchExistingTask(harness, task.id);

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(harness.subtaskRepo.findById(`${task.id}_subtask_running`)).toMatchObject({
      status: 'done',
      error: 'previous timeout',
    });
    expect(harness.taskRepo.findById(task.id)?.status).toBe('done');
    const events = harness.db.prepare('SELECT event_type FROM task_events WHERE task_id = ?').all(task.id) as Array<{ event_type: string }>;
    expect(events.map(event => event.event_type)).toContain('subtask_recovered_for_dispatch');
  });

  it('does not mark a task done for non-plan planner outcomes', async () => {
    const executor = createExecutor(async () => ({ success: true, output: 'should not execute', exitCode: 0, durationMs: 10 }));
    const harness = createHarness({ executor, sessionId: 'sess_non_plan_no_done' });
    const task = readyTask(harness.taskEngine, 'non-plan task');

    await dispatchExistingTask(harness, task.id, request(task.id, 'answer directly', directReplyIntent()));

    expect(executor.execute).not.toHaveBeenCalled();
    expect(harness.taskRepo.findById(task.id)?.status).toBe('running');
  });

  // When no subtask is ready, the dispatcher must distinguish two cases by subtask
  // state, not just by "no ready subtask found". Parameterized over the two
  // invariants the no-ready handler must preserve.
  describe.each([
    {
      name: 'all subtasks already done -> succeeds without re-running',
      seed: (taskId: string) => [{
        id: `${taskId}_subtask_done`,
        taskId,
        title: 'already done',
        status: 'done' as const,
        result: 'prior result',
      }],
      expectedTaskStatus: 'done' as const,
      expectExecutorCalled: false,
      expectedSubtaskStatus: 'done' as const,
    },
    {
      name: 'unfinished subtask blocked on missing dependency -> blocks',
      seed: (taskId: string) => [{
        id: `${taskId}_subtask_waiting`,
        taskId,
        title: 'waiting on missing dependency',
        dependsOn: [`${taskId}_missing_dependency`],
      }],
      expectedTaskStatus: 'blocked' as const,
      expectExecutorCalled: false,
      expectedSubtaskStatus: 'blocked' as const,
    },
  ])('no-ready-subtask dispatch: $name', ({ seed, expectedTaskStatus, expectExecutorCalled, expectedSubtaskStatus }) => {
    it('honors the no-ready-subtask invariant', async () => {
      const executor = createExecutor(async () => ({ success: true, output: 'should not execute', exitCode: 0, durationMs: 10 }));
      const harness = createHarness({ executor, sessionId: `sess_no_ready_${expectedTaskStatus}` });
      const task = readyTask(harness.taskEngine, 'no ready subtask');
      for (const subtaskSeed of seed(task.id)) {
        harness.subtaskRepo.upsert(subtask(subtaskSeed));
      }

      await dispatchExistingTask(harness, task.id);

      expect(executor.execute).toHaveBeenCalledTimes(expectExecutorCalled ? 1 : 0);
      expect(harness.taskRepo.findById(task.id)?.status).toBe(expectedTaskStatus);
      const seeded = seed(task.id)[0]!;
      expect(harness.subtaskRepo.findById(seeded.id)?.status).toBe(expectedSubtaskStatus);
    });
  });

  it('releases the current work unit and stops before the next subtask when task status changes mid-run', async () => {
    let taskId = '';
    let harness: ReturnType<typeof createHarness>;
    const executor = createExecutor(async () => {
      harness.taskEngine.cancel(taskId, 'cancel during execution');
      return { success: true, output: 'first result after cancel', exitCode: 0, durationMs: 10 };
    });
    harness = createHarness({ executor, sessionId: 'sess_status_drift_release' });
    const task = readyTask(harness.taskEngine, 'cancel between subtasks');
    taskId = task.id;
    harness.subtaskRepo.upsert(subtask({
      id: `${task.id}_subtask_first`,
      taskId: task.id,
      title: 'first',
      createdAt: '2026-07-02T00:00:00.000Z',
    }));
    harness.subtaskRepo.upsert(subtask({
      id: `${task.id}_subtask_second`,
      taskId: task.id,
      title: 'second',
      dependsOn: [`${task.id}_subtask_first`],
      createdAt: '2026-07-02T00:00:01.000Z',
    }));

    await dispatchExistingTask(harness, task.id);

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(harness.taskRepo.findById(task.id)?.status).toBe('cancelled');
    expect(harness.workUnitRepo.findById('executor-1')?.state).toBe('idle');
    expect(harness.subtaskRepo.findById(`${task.id}_subtask_second`)?.status).toBe('ready');
  });

  it('releases a claimed work unit when progress reporting throws', async () => {
    const executor = createExecutor(async (input) => {
      input.onProgress?.({ text: 'progress before crash' });
      return { success: true, output: 'should not complete', exitCode: 0, durationMs: 10 };
    });
    const harness = createHarness({ executor, sessionId: 'sess_throw_releases_claim' });
    const coordinator = (harness.session as any).sessionExecutionCoordinator;
    coordinator.deps.executionProgressService = {
      createTracker: vi.fn().mockReturnValue({
        evidenceText: [],
        onProgress: vi.fn(() => {
          throw new Error('progress callback crashed');
        }),
        clear: vi.fn(),
      }),
    };
    const task = readyTask(harness.taskEngine, 'throwing executor');

    await dispatchExistingTask(harness, task.id);

    expect(harness.taskRepo.findById(task.id)?.status).toBe('parked');
    expect(harness.workUnitRepo.findById('executor-1')?.state).toBe('idle');
    const workUnitEvents = harness.db.prepare('SELECT event_type FROM work_unit_events ORDER BY created_at ASC').all() as Array<{ event_type: string }>;
    expect(workUnitEvents.map(event => event.event_type)).toEqual(expect.arrayContaining(['claimed', 'running', 'failed', 'released']));
    const taskEvents = harness.db.prepare('SELECT event_type FROM task_events WHERE task_id = ?').all(task.id) as Array<{ event_type: string }>;
    expect(taskEvents.map(event => event.event_type)).toContain('subtask_exception');
  });

  it('aggregates multi-subtask output using execution order titles, not created_at order', async () => {
    const executor = createExecutor(async (input) => ({
      success: true,
      output: `output for ${input.userPrompt}`,
      exitCode: 0,
      durationMs: 10,
    }));
    const harness = createHarness({ executor, sessionId: 'sess_output_order' });
    const task = readyTask(harness.taskEngine, 'ordered subtasks');
    const firstExecutedId = `${task.id}_subtask_b`;
    const secondExecutedId = `${task.id}_subtask_a`;
    harness.subtaskRepo.upsert(subtask({
      id: secondExecutedId,
      taskId: task.id,
      title: 'A second by dependency',
      goal: 'goal A',
      dependsOn: [firstExecutedId],
      createdAt: '2026-07-02T00:00:00.000Z',
    }));
    harness.subtaskRepo.upsert(subtask({
      id: firstExecutedId,
      taskId: task.id,
      title: 'B first by dependency',
      goal: 'goal B',
      createdAt: '2026-07-02T00:00:01.000Z',
    }));

    await dispatchExistingTask(harness, task.id);

    const output = harness.session.getSnapshot().output.join('\n');
    expect(output.indexOf('## B first by dependency')).toBeLessThan(output.indexOf('## A second by dependency'));
    expect(output).toContain('## B first by dependency\n\noutput for goal B');
    expect(output).toContain('## A second by dependency\n\noutput for goal A');
  });

  it('sweeps expired work units, preserves claim metadata, and avoids permanent running locks', async () => {
    const executor = createExecutor(async () => ({ success: true, output: 'should not execute', exitCode: 0, durationMs: 10 }));
    const harness = createHarness({ executor, sessionId: 'sess_sweep_expired' });
    const task = readyTask(harness.taskEngine, 'expired work unit');
    const subtaskId = `${task.id}_subtask_ready`;
    harness.subtaskRepo.upsert(subtask({ id: subtaskId, taskId: task.id, title: 'ready after sweep' }));
    const expired: WorkUnit = {
      id: 'executor-1',
      agentClassName: 'codex-cli',
      agentClassKind: 'executor',
      state: 'running',
      claimedTaskId: task.id,
      claimedSubtaskId: subtaskId,
      heartbeatAt: '2026-07-02T00:00:00.000Z',
      leaseExpiresAt: '2026-07-02T00:00:00.000Z',
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    };
    harness.workUnitRepo.upsert(expired);

    await dispatchExistingTask(harness, task.id);

    expect(executor.execute).not.toHaveBeenCalled();
    expect(harness.workUnitRepo.findById('executor-1')).toMatchObject({
      state: 'heartbeat_lost',
      claimedTaskId: task.id,
      claimedSubtaskId: subtaskId,
    });
    expect(harness.taskRepo.findById(task.id)?.status).toBe('blocked');
    const taskEvents = harness.db.prepare('SELECT event_type FROM task_events WHERE task_id = ?').all(task.id) as Array<{ event_type: string }>;
    expect(taskEvents.map(event => event.event_type)).toContain('work_unit_heartbeat_lost');
  });
});
