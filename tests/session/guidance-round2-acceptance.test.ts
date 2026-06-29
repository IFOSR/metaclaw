import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/core/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { LlmBridge } from '../../src/core/llm-bridge.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import type { NotificationService } from '../../src/notifications/types.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createConfig(overrides?: Partial<Config['orchestration']>): Config {
  return {
    version: 1,
    executor: {
      command: 'codex',
      timeout: 60_000,
    },
    orchestration: {
      reminder_enabled: true,
      reminder_throttle: 60,
      top_k_preferences: 5,
      blocked_recheck_enabled: true,
      blocked_recheck_interval: 5,
      ...overrides,
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
  };
}

function createSession(config: Config, notifier?: NotificationService) {
  const db = createTestDb();
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
  const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
  const orchestration = new OrchestrationEngine(taskEngine);
  const contextRecaller = new ContextRecaller(db);
  const executor: ExecutorAdapter = {
    name: 'codex-cli',
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: 'ok',
      exitCode: 0,
      durationMs: 50,
    }),
    isAvailable: vi.fn().mockResolvedValue(true),
    abort: vi.fn(),
  };
  const llmBridge = {
    resolveRoute: vi.fn(),
    resolveIntent: vi.fn(),
    rankInteractions: vi.fn(),
  } as unknown as LlmBridge;

  const session = new MetaclawSession({
    taskEngine,
    memoryEngine,
    orchestration,
    executor,
    db,
    config,
    sessionId: 'sess_guidance_round2',
    contextRecaller,
    llmBridge,
    notifier,
  });

  return { session, taskEngine, taskRepo, executor };
}

describe('Round 2 guidance acceptance', () => {
  it('emits a throttled idle reminder when there is an actionable blocked task', () => {
    const { session, taskEngine } = createSession(createConfig({
      reminder_enabled: true,
      reminder_throttle: 60,
    }));

    const task = taskEngine.create({ title: 'Phoenix 周报', goal: '整理 Phoenix 周报' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: '等待 Phoenix 周报附件',
      status: 'waiting',
    });

    session.initialize({ resumeStartupTasks: false });
    session.maybeEmitIdleGuidance(1_000);
    const firstOutput = session.getSnapshot().output.join('\n');

    expect(firstOutput).toContain('💡 提醒');
    expect(firstOutput).toContain(task.id);
    expect(firstOutput).toContain('检查并解除阻塞');

    const outputSizeAfterFirstReminder = session.getSnapshot().output.length;
    session.maybeEmitIdleGuidance(10_000);
    expect(session.getSnapshot().output).toHaveLength(outputSizeAfterFirstReminder);

    session.maybeEmitIdleGuidance(62_000);
    const secondOutput = session.getSnapshot().output.join('\n');
    expect(secondOutput.match(/💡 提醒/g)?.length).toBe(2);
  });

  it('does not emit idle reminders when reminder_enabled is false', () => {
    const { session, taskEngine } = createSession(createConfig({
      reminder_enabled: false,
    }));

    const task = taskEngine.create({ title: 'Phoenix 任务', goal: '整理 Phoenix 材料' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: '等待 Phoenix 材料',
      status: 'waiting',
    });

    session.initialize({ resumeStartupTasks: false });
    session.maybeEmitIdleGuidance(5_000);

    expect(session.getSnapshot().output.join('\n')).not.toContain('💡 提醒');
  });

  it('periodically unblocks and resumes a recoverable executor-failure task', async () => {
    const { session, taskEngine, taskRepo, executor } = createSession(createConfig({
      blocked_recheck_enabled: true,
      blocked_recheck_interval: 5,
    }));

    const task = taskEngine.create({ title: '恢复网络失败任务', goal: '继续执行网络恢复后的任务' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: '执行器网络连接失败，请检查网络或代理配置',
      status: 'waiting',
    });

    session.initialize();
    const handled = await session.maybeReconcileBlockedTasksOnTimer(1_000);
    await session.waitForAsyncWork();

    expect(handled).toBe(true);
    expect(executor.isAvailable).toHaveBeenCalled();
    expect(executor.execute).toHaveBeenCalledTimes(1);
    const executionInput = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(executionInput.task.id).toBe(task.id);
    expect(executionInput.executionContextBundle.mode).toBe('resume-blocked');
    expect(taskRepo.findById(task.id)?.status).toBe('done');
    expect(session.getSnapshot().output.join('\n')).toContain('定时检查');
  });

  it('notifies when a system-resumed blocked task completes in the background', async () => {
    const notifier: NotificationService = {
      notifyMemoryCandidate: vi.fn().mockResolvedValue(undefined),
      notifyTaskCompleted: vi.fn().mockResolvedValue(undefined),
    };
    const { session, taskEngine, taskRepo } = createSession(createConfig({
      blocked_recheck_enabled: true,
      blocked_recheck_interval: 5,
    }), notifier);

    const task = taskEngine.create({ title: '后台恢复任务', goal: '继续执行后台恢复任务' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: '执行器网络连接失败，请检查网络或代理配置',
      status: 'waiting',
    });

    session.initialize();
    await session.maybeReconcileBlockedTasksOnTimer(1_000);
    await session.waitForAsyncWork();

    expect(taskRepo.findById(task.id)?.status).toBe('done');
    expect(notifier.notifyTaskCompleted).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      title: '后台恢复任务',
      summary: 'ok',
      executionMode: 'resume-blocked',
      origin: 'system',
      recoveryTrigger: expect.objectContaining({
        kind: 'timer-recheck',
        blockedReason: '执行器网络连接失败，请检查网络或代理配置',
        triggerReason: '定时检查确认执行器可用',
      }),
    }));
  });

  it('does not periodically resume blocked tasks that still need user materials', async () => {
    const { session, taskEngine, taskRepo, executor } = createSession(createConfig({
      blocked_recheck_enabled: true,
      blocked_recheck_interval: 5,
    }));

    const task = taskEngine.create({ title: '等待材料任务', goal: '整理用户补充材料' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: '等待用户补充材料',
      status: 'waiting',
    });

    session.initialize();
    const handled = await session.maybeReconcileBlockedTasksOnTimer(1_000);
    await session.waitForAsyncWork();

    expect(handled).toBe(false);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(taskRepo.findById(task.id)?.status).toBe('blocked');
  });

  it('does not periodically resume blocked tasks when recheck is disabled', async () => {
    const { session, taskEngine, taskRepo, executor } = createSession(createConfig({
      blocked_recheck_enabled: false,
    }));

    const task = taskEngine.create({ title: '关闭复检任务', goal: '继续执行网络恢复后的任务' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: '执行器网络连接失败，请检查网络或代理配置',
      status: 'waiting',
    });

    session.initialize();
    const handled = await session.maybeReconcileBlockedTasksOnTimer(1_000);

    expect(handled).toBe(false);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(taskRepo.findById(task.id)?.status).toBe('blocked');
  });

  it('task pool watchdog resumes executable parked tasks', async () => {
    const { session, taskEngine, taskRepo, executor } = createSession(createConfig({
      blocked_recheck_enabled: true,
      blocked_recheck_interval: 5,
    }));

    const task = taskEngine.create({ title: '被抢占任务', goal: '继续完成被抢占任务' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.park(task.id, '被更高优先级任务抢占：临时任务', {
      done: ['已完成前半段'],
      pending: ['继续输出后半段'],
      nextStep: '继续输出后半段',
      pauseReason: '被更高优先级任务抢占：临时任务',
    });

    session.initialize({ resumeStartupTasks: false });
    const handled = await session.maybeReviewTaskPoolOnTimer(1_000);
    await session.waitForAsyncWork();

    expect(handled).toBe(true);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    const executionInput = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(executionInput.task.id).toBe(task.id);
    expect(executionInput.executionContextBundle.mode).toBe('resume-parked');
    expect(taskRepo.findById(task.id)?.status).toBe('done');
    expect(session.getSnapshot().output.join('\n')).toContain('任务池看护：发现可执行任务');
  });

  it('task pool watchdog reminds users why blocked and parked tasks cannot run yet', async () => {
    const { session, taskEngine, executor } = createSession(createConfig({
      reminder_enabled: true,
      reminder_throttle: 60,
      blocked_recheck_enabled: true,
      blocked_recheck_interval: 5,
    }));

    const blockedTask = taskEngine.create({ title: '等待合同材料', goal: '整理合同材料' });
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '等待用户补充合同 PDF',
      status: 'waiting',
    });

    const parkedTask = taskEngine.create({ title: '人工暂停任务', goal: '继续人工暂停任务' });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '用户稍后再处理', {
      done: ['已整理初稿'],
      pending: ['补齐结论'],
      nextStep: '补齐结论',
      pauseReason: '用户稍后再处理',
    });
    taskEngine['taskRepo'].update(parkedTask.id, {
      prioritySignals: {
        ...parkedTask.prioritySignals,
        isReady: false,
      },
    });

    session.initialize();
    const handled = await session.maybeReviewTaskPoolOnTimer(1_000);

    const output = session.getSnapshot().output.join('\n');
    expect(handled).toBe(true);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(output).toContain('任务池看护提醒');
    expect(output).toContain(`#${blockedTask.id} 等待合同材料`);
    expect(output).toContain('等待用户补充合同 PDF');
    expect(output).toContain('还差：补充材料/文件/链接后');
    expect(output).toContain(`#${parkedTask.id} 人工暂停任务`);
    expect(output).toContain('用户稍后再处理');
    expect(output).toContain('下一步：补齐结论');
  });

  it('clears stale guidance after a resumed parked task finishes with no next suggestion', async () => {
    const { session, taskEngine, taskRepo } = createSession(createConfig({
      reminder_enabled: true,
      reminder_throttle: 60,
    }));

    const task = taskEngine.create({ title: 'Phoenix 周报', goal: '整理 Phoenix 周报' });
    taskRepo.update(task.id, {
      status: 'parked',
      summary: '已整理风险栏目，待补经营数据',
      snapshots: [{
        done: ['已整理风险栏目'],
        pending: ['待补经营数据'],
        nextStep: '补齐经营数据',
        pauseReason: '等待经营数据',
        createdAt: '2026-04-20T00:00:00Z',
      }],
      prioritySignals: {
        dueAt: null,
        isReady: true,
        progressRatio: 0.8,
        blocksOthers: false,
        idleHours: 1,
      },
      lastInterruptionReason: '被更高优先任务抢占',
    });

    session.initialize();

    await session.submit(`/task ${task.id} resume`, { awaitAsyncWork: true });

    expect(taskRepo.findById(task.id)?.status).toBe('done');
    expect(session.getSnapshot().latestGuidance).toBeNull();
  });
});
