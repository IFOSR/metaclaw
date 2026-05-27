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

describe('session dispatch recovery', () => {
  it('auto-resumes executable parked tasks when the scheduler is idle', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-auto-parked');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const task = taskEngine.create({ title: '等待恢复的挂起任务', goal: '继续执行等待恢复的挂起任务' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.park(task.id, '等待恢复', {
      done: ['已完成前置分析'],
      pending: ['继续输出结论'],
      nextStep: '继续输出结论',
      pauseReason: '等待恢复',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '挂起任务已自动恢复执行',
        exitCode: 0,
        durationMs: 300,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn(),
      resolveIntent: vi.fn(),
      resolveTaskPriority: vi.fn().mockResolvedValue({
        priority: 'urgent',
        reason: '语义判断：用户要求先处理这个临时任务',
      }),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_auto_parked_resume',
      contextRecaller,
      llmBridge,
      executorFactory: () => executor,
    });

    await (session as any).scheduler.scheduleNext();
    await session.waitForAsyncWork();

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect((executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0].task.id).toBe(task.id);
    expect((executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0].executionContextBundle.mode).toBe('resume-parked');
    expect(taskRepo.findById(task.id)?.status).toBe('done');
    expect(session.getSnapshot().output.join('\n')).toContain('恢复已挂起任务');
    expect(session.getSnapshot().output.join('\n')).toContain('挂起任务已自动恢复执行');
  });

  it('stores semantic task priority from the LLM when creating a new task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-semantic-priority');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '语义优先级任务完成',
        exitCode: 0,
        durationMs: 100,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: '明确工作任务' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: '新任务' }),
      resolveTaskPriority: vi.fn().mockResolvedValue({
        priority: 'urgent',
        reason: '语义判断：用户要求先处理这个临时任务',
      }),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_semantic_priority',
      contextRecaller,
      llmBridge,
      executorFactory: () => executor,
    });

    session.initialize();
    await session.submit('这个客户今晚要看，先处理一下 harness 对比', { awaitAsyncWork: true });

    const task = taskRepo.findAll().find(item => item.goal.includes('harness 对比'));
    expect(task?.prioritySignals.semanticPriority).toBe('urgent');
    expect(task?.prioritySignals.semanticPriorityReason).toBe('语义判断：用户要求先处理这个临时任务');
  });

  it('semantically reclassifies existing parked tasks before auto-resume ordering', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-parked-semantic-backfill');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const parkedTasks = [
      '顺序调研中国 harness 项目',
      '顺序调研欧洲 harness 项目',
      '客户马上要看，先处理美国 harness 项目对比',
      '顺序整理日本 harness 项目',
    ].map(title => taskEngine.create({ title, goal: title }));

    for (const task of parkedTasks) {
      taskEngine.transition(task.id, 'ready');
      taskEngine.transition(task.id, 'running');
      taskEngine.park(task.id, '等待恢复', {
        done: [],
        pending: ['继续调研'],
        nextStep: '继续调研',
        pauseReason: '等待恢复',
      });
    }

    const executionOrder: string[] = [];
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async ({ task }) => {
        executionOrder.push(task.id);
        return {
          success: true,
          output: `完成 ${task.title}`,
          exitCode: 0,
          durationMs: 100,
        };
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn(),
      resolveIntent: vi.fn(),
      resolveTaskPriority: vi.fn().mockImplementation(async (input: string) => input.includes('客户马上要看')
        ? { priority: 'urgent', reason: '语义判断：有明确时间压力，需要先处理' }
        : { priority: 'normal', reason: '语义判断：顺序执行即可' }),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_parked_semantic_backfill',
      contextRecaller,
      llmBridge,
      executorFactory: () => executor,
    });

    await (session as any).scheduler.scheduleNext();
    await session.waitForAsyncWork();

    const urgentTask = parkedTasks[2];
    expect(llmBridge.resolveTaskPriority).toHaveBeenCalledTimes(4);
    expect(executionOrder[0]).toBe(urgentTask.id);
    expect(taskRepo.findById(urgentTask.id)?.prioritySignals.semanticPriority).toBe('urgent');
    expect(session.getSnapshot().output.join('\n')).toContain('恢复已挂起任务');
    expect(session.getSnapshot().output.join('\n')).toContain(`完成 ${urgentTask.title}`);
  });

  it('rebuilds a missing execution request instead of leaving a task fake-running', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const task = taskEngine.create({ title: '恢复缺失派发上下文', goal: '继续执行缺失上下文的任务' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '已根据任务持久化目标恢复执行',
        exitCode: 0,
        durationMs: 300,
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
      config: createConfig(),
      sessionId: 'sess_missing_request_recovery',
      contextRecaller,
      llmBridge,
      executorFactory: () => executor,
    });

    await (session as any).dispatchTask(task.id);
    await session.waitForAsyncWork();

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect((executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0].userPrompt).toBe(task.goal);
    expect(taskRepo.findById(task.id)?.status).toBe('done');
    expect(session.getSnapshot().output.join('\n')).toContain(`任务 #${task.id} 缺少待执行上下文，已根据持久化任务信息重建执行请求`);
  });
});
