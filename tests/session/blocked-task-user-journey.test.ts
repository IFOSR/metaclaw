import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
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

function createConfig(): Config {
  return {
    version: 1,
    executor: {
      command: 'codex',
      timeout: 60_000,
    },
    orchestration: {
      reminder_enabled: true,
      reminder_throttle: 3600,
      top_k_preferences: 5,
      blocked_recheck_enabled: true,
      blocked_recheck_interval: 5,
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
  };
}

function semanticDurableTask(reason: string) {
  return JSON.stringify({
    interactionType: 'durable_task',
    confidence: 0.9,
    shouldAskBeforeActing: false,
    ambiguity: [],
    risk: 'low',
    reason,
    clarificationQuestion: null,
    taskBinding: { type: 'new', taskId: null, reason },
    taskControl: null,
    executorDecision: {
      selectedExecutor: 'codex-cli',
      action: 'auto_dispatch',
      confidence: 0.9,
      primaryIntent: 'general',
      matchedBoundary: ['general'],
      reason,
      candidates: [{ executorName: 'codex-cli', score: 0.9, reason, matchedBoundary: ['general'] }],
      rejected: [],
    },
  });
}

function semanticStatusQuery(scope: 'blocked' | 'running' | 'dashboard', reason: string) {
  return JSON.stringify({
    interactionType: 'task_control',
    confidence: 0.9,
    shouldAskBeforeActing: false,
    ambiguity: [],
    risk: 'low',
    reason,
    clarificationQuestion: null,
    taskBinding: { type: 'none', taskId: null, reason },
    taskControl: { kind: 'status_query', taskId: null, scope, reason },
    executorDecision: null,
  });
}

describe('blocked task user journey', () => {
  it('lets the user see, unblock, resume, and get notified about an old blocked task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-blocked-user-journey');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const notifier: NotificationService = {
      notifyMemoryCandidate: vi.fn().mockResolvedValue(undefined),
      notifyTaskCompleted: vi.fn().mockResolvedValue(undefined),
    };
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn()
        .mockResolvedValueOnce({
          success: false,
          output: '',
          error: '执行器网络连接失败，请检查网络或代理配置',
          exitCode: 1,
          durationMs: 100,
        })
        .mockResolvedValueOnce({
          success: true,
          output: '阻塞解除后已完成用户旅程验收报告',
          exitCode: 0,
          durationMs: 120,
        }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      query: vi.fn()
        .mockResolvedValueOnce(semanticDurableTask('明确验收任务'))
        .mockResolvedValueOnce(semanticStatusQuery('blocked', '查询阻塞任务')),
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: '明确验收任务' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: '新任务' }),
      resolveTaskPriority: vi.fn().mockResolvedValue({ priority: 'normal', reason: '默认优先级' }),
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_blocked_user_journey',
      contextRecaller,
      llmBridge,
      notifier,
      availableExecutorCommands: new Set(['codex']),
    });

    session.initialize();
    await session.submit('整理 blocked 任务用户旅程验收报告', { awaitAsyncWork: true });

    const blockedTask = taskRepo.findByStatus('blocked')[0];
    expect(blockedTask).toBeTruthy();
    expect(blockedTask.dependencies[0]?.description).toBe('执行器网络连接失败，请检查网络或代理配置');
    let output = session.getSnapshot().output.join('\n');
    expect(output).toContain(`任务 #${blockedTask.id} 已转为阻塞`);
    expect(output).toContain(`/task ${blockedTask.id} unblock`);

    await session.submit('当前有没有被阻塞的任务？', { awaitAsyncWork: true });
    output = session.getSnapshot().output.join('\n');
    expect(output).toContain('当前有 1 个阻塞任务');
    expect(output).toContain(`#${blockedTask.id} [BLOCKED] ${blockedTask.title}`);
    expect(output).toContain(`建议动作：/task ${blockedTask.id} unblock，或直接补充材料/说明后让我继续`);

    await session.submit(`/task ${blockedTask.id} unblock`, { awaitAsyncWork: true });

    expect(taskRepo.findById(blockedTask.id)?.status).toBe('done');
    expect(executor.execute).toHaveBeenCalledTimes(2);
    const resumedInput = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(resumedInput.task.id).toBe(blockedTask.id);
    expect(resumedInput.executionContextBundle.mode).toBe('resume-blocked');

    output = session.getSnapshot().output.join('\n');
    expect(output).toContain(`任务 #${blockedTask.id} 已解除阻塞`);
    expect(output).toContain('✓ 旧阻塞任务已完成');
    expect(output).toContain('这是针对旧任务的答案');
    expect(output).toContain('触发方式：你刚才显式解除/继续旧阻塞任务');
    expect(output).toContain('原阻塞原因：执行器网络连接失败，请检查网络或代理配置');
    expect(output).toContain('阻塞解除后已完成用户旅程验收报告');
    expect(notifier.notifyTaskCompleted).toHaveBeenCalledWith(expect.objectContaining({
      taskId: blockedTask.id,
      title: blockedTask.title,
      executionMode: 'resume-blocked',
      origin: 'user',
      recoveryTrigger: expect.objectContaining({
        kind: 'explicit-task-command',
        blockedReason: '执行器网络连接失败，请检查网络或代理配置',
        triggerReason: '显式解除阻塞',
      }),
    }));
  });
});
