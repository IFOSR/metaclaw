import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { runMigrations } from '../../src/storage/migrations.js';
import { SessionPersistenceService } from '../../src/core/session-persistence-service.js';
import { MemoryCaptureService } from '../../src/core/memory-capture-service.js';
import { TaskResumePlanner } from '../../src/core/task-resume-planner.js';
import { MemoryEngine } from '../../src/core/memory-engine.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryAuditEventRepo } from '../../src/storage/memory-audit-event-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { OrchestrationEngine } from '../../src/core/orchestration.js';
import { TaskRuntimeService } from '../../src/core/task-runtime-service.js';
import { TaskSemanticService } from '../../src/core/task-semantic-service.js';
import { ConversationRuntimeService } from '../../src/core/conversation-runtime-service.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { ExecutorRouteDecision } from '../../src/core/executor-router.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createRuntime(db: Database.Database) {
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, resolve(tmpdir(), `metaclaw-session-extraction-${Date.now()}`));
  const orchestration = new OrchestrationEngine(taskEngine);
  const executor: ExecutorAdapter = {
    name: 'codex-cli',
    execute: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    abort: vi.fn(),
  };
  const taskRuntimeService = new TaskRuntimeService({ taskEngine, taskRepo, orchestration });
  const taskSemanticService = new TaskSemanticService({
    llmBridge: {},
    timeoutMs: () => 50,
  });
  return { taskRepo, taskEngine, taskRuntimeService, taskSemanticService };
}

describe('session extraction services', () => {
  it('persists interactions and route event results outside MetaclawSession', () => {
    const db = createTestDb();
    const service = new SessionPersistenceService(db);
    const decision: ExecutorRouteDecision = {
      selectedExecutor: 'codex-cli',
      action: 'auto_dispatch',
      candidates: [],
      primaryIntent: 'repo_execution',
      matchedBoundary: ['repo_execution'],
      rejected: [],
      reason: 'test route',
      confidence: 0.9,
    };

    service.recordInteraction({
      taskId: 'task_1',
      sessionId: 'session_1',
      userInput: 'build it',
      systemOutput: 'done',
      executorUsed: 'codex-cli',
    });
    const routeEventId = service.recordRouteEvent({
      taskId: 'task_1',
      userInput: 'build it',
      decision,
    });
    service.markRouteEventResult(routeEventId, 'success');

    const interaction = db.prepare('SELECT task_id, session_id, user_input, system_output, executor_used FROM interactions').get() as Record<string, string>;
    expect(interaction).toMatchObject({
      task_id: 'task_1',
      session_id: 'session_1',
      user_input: 'build it',
      system_output: 'done',
      executor_used: 'codex-cli',
    });
    const routeEvent = db.prepare('SELECT id, result FROM executor_route_events').get() as Record<string, string>;
    expect(routeEvent.id).toBe(routeEventId);
    expect(routeEvent.result).toBe('success');
  });

  it('captures high-confidence preferences, audits auto-capture, and emits notification candidates', () => {
    const db = createTestDb();
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const notifier = { notifyTaskCompleted: vi.fn(), notifyMemoryCandidate: vi.fn().mockResolvedValue(undefined) };
    const service = new MemoryCaptureService({
      db,
      memoryEngine,
      notifier,
      deliveryService: {
        deliverMemoryCandidate: vi.fn((notificationService, input) => {
          void notificationService.notifyMemoryCandidate(input);
        }),
      },
    });

    const lowRisk = service.captureHighConfidencePreferences('偏好：以后报告默认先给结论再给证据', 'session:test');
    const highRisk = service.captureHighConfidencePreferences('偏好：以后凡是报告都自动发给客户', 'session:test');

    expect(lowRisk.lines.join('\n')).toContain('已自动记录偏好');
    expect(memoryEngine.list().map(pref => pref.content)).toContain('以后报告默认先给结论再给证据');
    expect(new MemoryAuditEventRepo(db).findByAction('auto_capture')).toHaveLength(1);
    expect(highRisk.lines.join('\n')).toContain('高风险偏好不会静默写入');
    expect(notifier.notifyMemoryCandidate).toHaveBeenCalledTimes(1);
  });

  it('plans resume, blocked recovery, and follow-up decisions without session branching', async () => {
    const db = createTestDb();
    const { taskEngine, taskRuntimeService, taskSemanticService } = createRuntime(db);
    const sessionStateRepo = { get: vi.fn() };
    const planner = new TaskResumePlanner({ taskRuntimeService, taskSemanticService, sessionStateRepo });

    const parked = taskEngine.create({ title: 'parked', goal: 'parked' });
    taskEngine.transition(parked.id, 'ready');
    taskEngine.transition(parked.id, 'running');
    taskEngine.park(parked.id, 'pause', {
      done: [],
      pending: ['continue'],
      nextStep: 'continue',
      pauseReason: 'pause',
    });
    sessionStateRepo.get.mockReturnValue({ lastFocusedTaskId: parked.id, lastCompletedTaskId: null });
    const resume = await planner.planLastTaskContinuation('继续刚才的任务');
    expect(resume.action).toBe('execute_existing');
    expect(resume.action === 'execute_existing' ? resume.executionMode : null).toBe('resume-parked');

    const blocked = taskEngine.create({ title: 'blocked', goal: 'blocked' });
    taskEngine.transition(blocked.id, 'ready');
    taskEngine.transition(blocked.id, 'running');
    taskEngine.block(blocked.id, {
      taskId: blocked.id,
      type: 'manual',
      description: '等待材料',
      status: 'waiting',
    });
    const recovery = planner.planBlockedRecovery('材料已补充，可以继续');
    expect(recovery.action).toBe('unblock_and_execute');

    const blockedSnapshot = taskRuntimeService.findTask(blocked.id);
    expect(blockedSnapshot?.status).toBe('blocked');
    const referencedBlockedRecovery = planner.planReferencedTask({
      userInput: `执行阻塞任务 ${blocked.id}`,
      referencedTask: blockedSnapshot!,
      intentDecision: {
        interactionType: 'task_control',
        confidence: 1,
        reason: 'explicit blocked resume',
        clarificationQuestion: null,
        risk: { level: 'low', requiresConfirmation: false, reasons: [] },
        task: { binding: 'reference', taskId: blocked.id, control: 'recover_blocked', scope: null },
        execution: {
          mode: 'none',
          complexity: 'simple',
          selectedExecutor: null,
          candidateExecutors: [],
          requiresVerification: false,
          canModifyFiles: false,
          requiresExternalGateway: false,
        },
        hints: [],
      },
    });
    expect(referencedBlockedRecovery.action).toBe('unblock_and_execute');
    expect(referencedBlockedRecovery.action === 'unblock_and_execute'
      ? referencedBlockedRecovery.observeResumeIntent
      : null).toBe(true);

    const doneTask = taskEngine.create({ title: 'done', goal: 'done' });
    taskEngine.transition(doneTask.id, 'ready');
    taskEngine.transition(doneTask.id, 'running');
    const done = taskEngine.transition(doneTask.id, 'done');
    expect(planner.planReferencedTask({
      userInput: '基于它继续做',
      referencedTask: done,
      intentDecision: {
        interactionType: 'task_control',
        confidence: 1,
        reason: 'reference',
        clarificationQuestion: null,
        risk: { level: 'low', requiresConfirmation: false, reasons: [] },
        task: { binding: 'reference', taskId: done.id, control: 'resume_task', scope: null },
        execution: {
          mode: 'none',
          complexity: 'simple',
          selectedExecutor: null,
          candidateExecutors: [],
          requiresVerification: false,
          canModifyFiles: false,
          requiresExternalGateway: false,
        },
        hints: [],
      },
    }).action).toBe('fork_follow_up');
  });

  it('runs normal conversation through a core runtime service and persists successful turns', async () => {
    const db = createTestDb();
    const conversationHistory = [{
      taskId: '',
      sessionId: 'session_1',
      userInput: '上一轮',
      systemOutput: '上一轮回复',
      createdAt: '2026-06-24T00:00:00.000Z',
      source: 'session' as const,
    }];
    const memoryContextService = {
      recallConversationContext: vi.fn().mockResolvedValue(conversationHistory),
    };
    const persistenceService = {
      recordInteraction: vi.fn(),
    };
    const appendOutput = vi.fn();
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '你好，我在。',
        exitCode: 0,
        durationMs: 10,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const service = new ConversationRuntimeService({
      executor,
      memoryContextService,
      persistenceService,
      appendOutput,
    });

    const result = await service.run({
      sessionId: 'session_1',
      userInput: 'hi',
    });

    expect(result).toEqual({
      success: true,
      lines: ['你好，我在。'],
      focus: { kind: 'conversation', taskId: null },
    });
    expect(memoryContextService.recallConversationContext).toHaveBeenCalledWith({
      sessionId: 'session_1',
      userInput: 'hi',
    });
    expect(appendOutput).toHaveBeenCalledWith(
      '【MetaClaw｜召回会话上下文】',
      '→ MetaClaw：正在召回与本次问答相关的最近对话',
    );
    expect(appendOutput).toHaveBeenCalledWith(
      '→ MetaClaw：已召回 1 条相关会话上下文',
      '→ MetaClaw：会把召回上下文注入给 Executor，保持连续问答衔接',
      '【Executor: codex-cli｜回答生成】',
      '→ Executor: codex-cli 正在基于当前问题和会话上下文生成回答',
    );
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      preferences: [],
      userPrompt: 'hi',
      conversationHistory,
      task: expect.objectContaining({
        id: expect.stringMatching(/^conv_/u),
        title: '普通对话',
        goal: 'hi',
        status: 'running',
      }),
    }));
    expect(persistenceService.recordInteraction).toHaveBeenCalledWith({
      taskId: null,
      sessionId: 'session_1',
      userInput: 'hi',
      systemOutput: '你好，我在。',
      executorUsed: 'codex-cli',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
  });

  it('does not persist failed or exceptional conversation turns', async () => {
    const memoryContextService = {
      recallConversationContext: vi.fn().mockResolvedValue([]),
    };
    const persistenceService = {
      recordInteraction: vi.fn(),
    };
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn()
        .mockResolvedValueOnce({
          success: false,
          output: '',
          error: 'LLM failed',
          exitCode: 1,
          durationMs: 10,
        })
        .mockRejectedValueOnce(new Error('process crashed')),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const service = new ConversationRuntimeService({
      executor,
      memoryContextService,
      persistenceService,
    });

    await expect(service.run({
      sessionId: 'session_1',
      userInput: '第一次',
    })).resolves.toEqual({
      success: false,
      lines: ['✗ 对话失败: LLM failed'],
      focus: null,
    });
    await expect(service.run({
      sessionId: 'session_1',
      userInput: '第二次',
    })).resolves.toEqual({
      success: false,
      lines: ['✗ 对话异常: process crashed'],
      focus: null,
    });
    expect(persistenceService.recordInteraction).not.toHaveBeenCalled();
  });

  it('shows when a conversation answer has no recalled context', async () => {
    const memoryContextService = {
      recallConversationContext: vi.fn().mockResolvedValue([]),
    };
    const persistenceService = {
      recordInteraction: vi.fn(),
    };
    const appendOutput = vi.fn();
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '这是一个新的回答。',
        exitCode: 0,
        durationMs: 10,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const service = new ConversationRuntimeService({
      executor,
      memoryContextService,
      persistenceService,
      appendOutput,
    });

    await service.run({
      sessionId: 'session_1',
      userInput: '新问题',
    });

    expect(appendOutput).toHaveBeenCalledWith(
      '→ MetaClaw：没有召回到相关会话上下文，将按全新问题回答',
      '【Executor: codex-cli｜回答生成】',
      '→ Executor: codex-cli 正在基于当前问题生成回答',
    );
  });

  it('injects recent context for half-answer continuation replies so the executor can resolve the semantic topic', async () => {
    const recentContext = [{
      taskId: null,
      sessionId: 'session_1',
      userInput: 'MetaClaw 调度任务时为什么要明确展示 Executor？',
      systemOutput: '刚才解释到：第一，用户需要知道当前由哪个 Executor 处理；第二，里程碑要区分 MetaClaw 和 Executor。',
      createdAt: '2026-06-24T00:00:00.000Z',
      source: 'session' as const,
    }];
    const memoryContextService = {
      recallConversationContext: vi.fn().mockResolvedValue(recentContext),
    };
    const persistenceService = {
      recordInteraction: vi.fn(),
    };
    const appendOutput = vi.fn();
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '继续刚才的问题：第三，展示上下文召回依据可以降低用户困惑。',
        exitCode: 0,
        durationMs: 10,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const service = new ConversationRuntimeService({
      executor,
      memoryContextService,
      persistenceService,
      appendOutput,
    });

    await service.run({
      sessionId: 'session_1',
      userInput: '这个问题你怎么回答了一半？继续完成。',
    });

    expect(memoryContextService.recallConversationContext).toHaveBeenCalledWith({
      sessionId: 'session_1',
      userInput: '这个问题你怎么回答了一半？继续完成。',
    });
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      conversationHistory: recentContext,
    }));
    expect(appendOutput).toHaveBeenCalledWith(
      '→ MetaClaw：已召回 1 条相关会话上下文',
      '→ MetaClaw：会把召回上下文注入给 Executor，保持连续问答衔接',
      '【Executor: codex-cli｜回答生成】',
      '→ Executor: codex-cli 正在基于当前问题和会话上下文生成回答',
    );
  });
});
