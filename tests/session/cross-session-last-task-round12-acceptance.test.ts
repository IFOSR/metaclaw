import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { MemoryEngine } from '../../src/core/memory-engine.js';
import { OrchestrationEngine } from '../../src/core/orchestration.js';
import { ContextRecaller } from '../../src/core/context-recaller.js';
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { LlmBridge } from '../../src/core/llm-bridge.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';

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
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
  };
}

function createDurableRouteBridge(overrides: Partial<LlmBridge> = {}) {
  return {
    resolveRoute: vi.fn().mockResolvedValue({
      route: 'durable_task',
      reason: '明确任务',
    }),
    resolveIntent: vi.fn().mockResolvedValue({
      type: 'new',
      taskId: null,
      reason: '新任务',
    }),
    rankInteractions: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as LlmBridge;
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

function semanticLastTaskContinuation(reason: string) {
  return JSON.stringify({
    interactionType: 'task_control',
    confidence: 0.92,
    shouldAskBeforeActing: false,
    ambiguity: [],
    risk: 'low',
    reason,
    clarificationQuestion: null,
    taskBinding: { type: 'none', taskId: null, reason },
    taskControl: { kind: 'last_task_continuation', taskId: null, scope: null, reason },
    executorDecision: null,
  });
}

describe('cross-session last-task continuation', () => {
  it('auto-creates a follow-up instead of asking for confirmation when the last focused task is done', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor1: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '智谱投资分析已完成',
        exitCode: 0,
        durationMs: 100,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const session1 = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor: executor1,
      db,
      config: createConfig(),
      sessionId: 'sess_round12_a',
      contextRecaller,
      llmBridge: createDurableRouteBridge({
        query: vi.fn().mockResolvedValue(semanticDurableTask('明确任务')),
      }),
      availableExecutorCommands: new Set(['codex']),
    });

    session1.initialize();
    await session1.submit('智谱这家公司从现在看是否值得投资？你怎么看？', { awaitAsyncWork: true });
    await session1.submit('/exit', { awaitAsyncWork: true });

    const executor2: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'follow-up 已执行',
        exitCode: 0,
        durationMs: 100,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge2 = createDurableRouteBridge({
      query: vi.fn().mockResolvedValue(semanticLastTaskContinuation('继续上次任务')),
    });
    const session2 = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor: executor2,
      db,
      config: createConfig(),
      sessionId: 'sess_round12_b',
      contextRecaller,
      llmBridge: llmBridge2,
      availableExecutorCommands: new Set(['codex']),
    });

    session2.initialize();
    await session2.submit('继续之前的任务', { awaitAsyncWork: true });

    const output = session2.getSnapshot().output.join('\n');
    expect(output).toContain('上次任务自动处理');
    expect(output).toContain('上一个任务已完成');
    expect(output).toContain('自动决策：基于上一个任务创建 follow-up');
    expect(llmBridge2.resolveRoute).not.toHaveBeenCalled();
    expect(llmBridge2.resolveIntent).not.toHaveBeenCalled();

    expect(executor2.execute).toHaveBeenCalledTimes(1);
    const followUpInput = (executor2.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(followUpInput.executionContextBundle.mode).toBe('follow-up');
  });

  it('allows the user to choose resuming the most recent unfinished task instead of the last completed task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor1: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '智谱投资分析已完成',
        exitCode: 0,
        durationMs: 100,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const session1 = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor: executor1,
      db,
      config: createConfig(),
      sessionId: 'sess_round12_c',
      contextRecaller,
      llmBridge: createDurableRouteBridge({
        query: vi.fn().mockResolvedValue(semanticDurableTask('明确任务')),
      }),
      availableExecutorCommands: new Set(['codex']),
    });

    session1.initialize();
    await session1.submit('智谱这家公司从现在看是否值得投资？你怎么看？', { awaitAsyncWork: true });
    await session1.submit('/exit', { awaitAsyncWork: true });

    const unfinishedTask = taskEngine.create({
      title: '比亚迪 vs 宁德时代 市场份额调研',
      goal: '继续比亚迪 vs 宁德时代的新能源电池市场份额调研',
    });
    taskEngine.transition(unfinishedTask.id, 'ready');
    taskEngine.transition(unfinishedTask.id, 'running');
    taskEngine.park(unfinishedTask.id, '等待继续', {
      done: ['已整理基础对比框架'],
      pending: ['继续补齐最新市场份额数据'],
      nextStep: '补齐市场份额数据并更新结论',
      pauseReason: '等待继续',
    });

    const executor2: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '比亚迪 vs 宁德时代调研已恢复',
        exitCode: 0,
        durationMs: 100,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge2 = createDurableRouteBridge({
      query: vi.fn().mockResolvedValue(semanticLastTaskContinuation('继续上次任务')),
    });
    const session2 = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor: executor2,
      db,
      config: createConfig(),
      sessionId: 'sess_round12_d',
      contextRecaller,
      llmBridge: llmBridge2,
      availableExecutorCommands: new Set(['codex']),
    });

    session2.initialize();
    await session2.submit('继续之前的任务', { awaitAsyncWork: true });

    const output = session2.getSnapshot().output.join('\n');
    expect(output).toContain('上次任务自动处理');
    expect(output).toContain(`自动决策：恢复最近未完成任务 #${unfinishedTask.id}`);

    expect(executor2.execute).toHaveBeenCalledTimes(1);
    const resumedInput = (executor2.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(resumedInput.task.id).toBe(unfinishedTask.id);
    expect(resumedInput.executionContextBundle.mode).toBe('resume-parked');
    expect(llmBridge2.resolveRoute).not.toHaveBeenCalled();
    expect(llmBridge2.resolveIntent).not.toHaveBeenCalled();
  });

  it('falls back to LLM intent resolution only when persisted last-task pointers are unavailable', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const parkedTask = taskEngine.create({
      title: '历史未完成调研',
      goal: '继续历史未完成调研',
    });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '等待继续', {
      done: ['已整理框架'],
      pending: ['继续补齐数据'],
      nextStep: '继续补齐数据',
      pauseReason: '等待继续',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '历史任务已恢复',
        exitCode: 0,
        durationMs: 100,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = createDurableRouteBridge({
      resolveRoute: vi.fn().mockResolvedValue({
        route: 'task_control',
        reason: '显式继续任务',
      }),
      resolveIntent: vi.fn().mockResolvedValue({
        type: 'reference',
        taskId: parkedTask.id,
        reason: '命中旧任务',
      }),
    });
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_round12_e',
      contextRecaller,
      llmBridge,
      availableExecutorCommands: new Set(['codex']),
    });

    session.initialize();
    await session.submit('继续之前的任务', { awaitAsyncWork: true });

    expect(llmBridge.resolveRoute).toHaveBeenCalledTimes(1);
    expect(llmBridge.resolveIntent).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});
