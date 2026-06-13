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

describe('Round 3 task boundary acceptance', () => {
  it('turns conversation-derived follow-up work into a new task with inherited conversation context', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    let parkedTaskId = '';

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn()
        .mockResolvedValueOnce({
          success: true,
          output: '强模型减少的是脚手架式 harness，不会消灭操作系统式 harness。',
          exitCode: 0,
          durationMs: 80,
        })
        .mockResolvedValueOnce({
          success: true,
          output: '三点结论：1. 强模型减少脚手架；2. 任务状态仍需系统层管理；3. 调度和恢复最难被替代。',
          exitCode: 0,
          durationMs: 90,
        }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn()
        .mockResolvedValueOnce({
          route: 'conversation',
          reason: '普通讨论',
        })
        .mockResolvedValueOnce({
          route: 'task_control',
          reason: '因为提到了刚才，误判为旧任务控制',
        }),
      resolveIntent: vi.fn().mockImplementation(async () => ({
        type: 'reference',
        taskId: parkedTaskId,
        reason: '误判为恢复旧 parked 任务',
      })),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_round3_boundary',
      contextRecaller,
      llmBridge,
    });

    session.initialize();

    const parkedTask = taskEngine.create({
      title: '旧的 memory 调研任务',
      goal: '继续完善 memory 方向的开源项目对比',
    });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '用户手动暂停', {
      done: ['已整理 memory 分类'],
      pending: ['继续补齐开源项目对比'],
      nextStep: '继续完善方案对比',
      pauseReason: '用户手动暂停',
    });
    taskRepo.update(parkedTask.id, {
      lastInterruptionReason: '用户手动暂停',
      summary: '已整理 memory 分类',
      prioritySignals: {
        ...parkedTask.prioritySignals,
        isReady: false,
      },
    });
    parkedTaskId = parkedTask.id;

    await session.submit('未来随着基座模型的能力越来越强，是否还需要 harness', { awaitAsyncWork: true });
    await session.submit('把刚才那段分析整理成三点结论', { awaitAsyncWork: true });

    expect(executor.execute).toHaveBeenCalledTimes(2);
    const secondCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(secondCall.task.id).not.toBe(parkedTaskId);
    expect(secondCall.task.title).toContain('把刚才那段分析整理成三点结论');
    expect(secondCall.conversationHistory.some((turn: { userInput: string }) => turn.userInput.includes('未来随着基座模型'))).toBe(true);
    expect(taskRepo.findById(parkedTaskId)?.status).toBe('parked');

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).not.toContain(`关联到任务 #${parkedTaskId}`);
    expect(snapshot).toContain('任务 #');
  });

  it('handles natural language clearing of blocked tasks without creating a new task', async () => {
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
        output: '不应执行',
        exitCode: 0,
        durationMs: 1,
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
      sessionId: 'sess_clear_blocked_tasks',
      contextRecaller,
      llmBridge,
    });

    session.initialize();

    const blockedTask = taskEngine.create({ title: '被阻塞任务', goal: '等待补材料' });
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '等待材料',
      status: 'waiting',
    });

    const readyTask = taskEngine.create({ title: '待执行任务', goal: '继续排队' });
    taskEngine.transition(readyTask.id, 'ready');

    await session.submit('清空阻塞的任务', { awaitAsyncWork: true });

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).toContain('已清空阻塞任务：取消 1 个任务');
    expect(snapshot).toContain(blockedTask.id);
    expect(taskRepo.findById(blockedTask.id)?.status).toBe('cancelled');
    expect(taskRepo.findById(readyTask.id)?.status).toBe('ready');
    expect(taskRepo.findAll()).toHaveLength(2);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(llmBridge.resolveRoute).not.toHaveBeenCalled();
    expect(llmBridge.resolveIntent).not.toHaveBeenCalled();
  });

  it('answers blocked-task status queries from MetaClaw state without calling the executor', async () => {
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
        output: '不应执行',
        exitCode: 0,
        durationMs: 1,
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
      sessionId: 'sess_query_blocked_tasks',
      contextRecaller,
      llmBridge,
    });

    session.initialize();

    const blockedTask = taskEngine.create({ title: '飞书客户端接入', goal: '修复飞书链路' });
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '执行器网络连接失败，请检查网络或代理配置',
      status: 'waiting',
    });

    await session.submit('当前有没有被阻塞的任务？', { awaitAsyncWork: true });

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).toContain('当前有 1 个阻塞任务');
    expect(snapshot).toContain(`#${blockedTask.id} [BLOCKED] 飞书客户端接入`);
    expect(snapshot).toContain('执行器网络连接失败，请检查网络或代理配置');
    expect(taskRepo.findById(blockedTask.id)?.status).toBe('blocked');
    expect(taskRepo.findAll()).toHaveLength(1);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(llmBridge.resolveRoute).not.toHaveBeenCalled();
    expect(llmBridge.resolveIntent).not.toHaveBeenCalled();
  });

  it('answers no blocked tasks from MetaClaw state without creating a task', async () => {
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
        output: '不应执行',
        exitCode: 0,
        durationMs: 1,
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
      sessionId: 'sess_query_no_blocked_tasks',
      contextRecaller,
      llmBridge,
    });

    session.initialize();

    await session.submit('检查一下有没有 blocked 任务', { awaitAsyncWork: true });

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).toContain('当前没有阻塞任务。');
    expect(taskRepo.findAll()).toHaveLength(0);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(llmBridge.resolveRoute).not.toHaveBeenCalled();
    expect(llmBridge.resolveIntent).not.toHaveBeenCalled();
  });

  it('handles natural language clearing of all manageable tasks and aborts running work', async () => {
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
        output: '不应执行',
        exitCode: 0,
        durationMs: 1,
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
      sessionId: 'sess_clear_all_tasks',
      contextRecaller,
      llmBridge,
    });

    session.initialize();

    const runningTask = taskEngine.create({ title: '执行中的任务', goal: '执行中' });
    taskEngine.transition(runningTask.id, 'ready');
    taskEngine.transition(runningTask.id, 'running');

    const parkedTask = taskEngine.create({ title: '挂起任务', goal: '挂起中' });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '用户暂停', {
      done: [],
      pending: ['继续'],
      nextStep: '继续',
      pauseReason: '用户暂停',
    });

    const doneTask = taskEngine.create({ title: '已完成任务', goal: '已完成' });
    taskEngine.transition(doneTask.id, 'ready');
    taskEngine.transition(doneTask.id, 'running');
    taskEngine.transition(doneTask.id, 'done');

    await session.submit('清空所有任务', { awaitAsyncWork: true });

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).toContain('已清空所有未完成任务：取消 2 个任务');
    expect(snapshot).toContain('已中止当前执行器');
    expect(taskRepo.findById(runningTask.id)?.status).toBe('cancelled');
    expect(taskRepo.findById(parkedTask.id)?.status).toBe('cancelled');
    expect(taskRepo.findById(doneTask.id)?.status).toBe('done');
    expect(executor.abort).toHaveBeenCalledTimes(1);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(llmBridge.resolveRoute).not.toHaveBeenCalled();
  });

  it('resumes an explicitly requested parked task instead of creating a new task when intent is misclassified', async () => {
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
        output: '挂起任务已恢复',
        exitCode: 0,
        durationMs: 10,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    let parkedTaskId = '';
    const llmBridge = {
      resolveTaskResumeIntent: vi.fn().mockImplementation(async () => ({
        action: 'resume',
        taskId: parkedTaskId,
        reason: '用户语义上要求重启这个已挂起任务',
        confidence: 0.94,
      })),
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: '误判为新工作' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: '误判为新建任务' }),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_resume_parked_without_new_task',
      contextRecaller,
      llmBridge,
      availableExecutorCommands: new Set(['codex']),
    });

    session.initialize();

    const parkedTask = taskEngine.create({ title: 'Pi Agent 调研任务', goal: '继续调研 Pi Agent 能力' });
    parkedTaskId = parkedTask.id;
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '用户暂停', {
      done: ['已经完成初步资料整理'],
      pending: ['补齐 npm 和 GitHub 信息'],
      nextStep: '继续搜索资料',
      pauseReason: '用户暂停',
    });

    const beforeCount = taskRepo.findAll().length;
    await session.submit(`重启挂起任务 ${parkedTask.id}`, { awaitAsyncWork: true });

    expect(taskRepo.findAll()).toHaveLength(beforeCount);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    const executionInput = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(executionInput.task.id).toBe(parkedTask.id);
    expect(executionInput.executionContextBundle.mode).toBe('resume-parked');
    expect(session.getSnapshot().output.join('\n')).toContain(`命中已有挂起任务 #${parkedTask.id}`);
    expect(llmBridge.resolveTaskResumeIntent).toHaveBeenCalledTimes(1);
    expect(llmBridge.resolveRoute).not.toHaveBeenCalled();
    expect(llmBridge.resolveIntent).not.toHaveBeenCalled();
  });

  it('unblocks and resumes an explicitly requested blocked task instead of creating a new task', async () => {
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
        output: '阻塞任务已恢复',
        exitCode: 0,
        durationMs: 10,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    let blockedTaskId = '';
    const llmBridge = {
      resolveTaskResumeIntent: vi.fn().mockImplementation(async () => ({
        action: 'resume',
        taskId: blockedTaskId,
        reason: '用户语义上要求执行这个已阻塞任务',
        confidence: 0.93,
      })),
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: '误判为新工作' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: '误判为新建任务' }),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_resume_blocked_without_new_task',
      contextRecaller,
      llmBridge,
      availableExecutorCommands: new Set(['codex']),
    });

    session.initialize();

    const blockedTask = taskEngine.create({ title: '飞书云文档调研', goal: '继续调研飞书云文档能力' });
    blockedTaskId = blockedTask.id;
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '执行器权限受限，请确认已授予所需目录访问权限后重试',
      status: 'waiting',
    });

    const beforeCount = taskRepo.findAll().length;
    await session.submit(`执行阻塞任务 ${blockedTask.id}`, { awaitAsyncWork: true });

    expect(taskRepo.findAll()).toHaveLength(beforeCount);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    const executionInput = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(executionInput.task.id).toBe(blockedTask.id);
    expect(executionInput.executionContextBundle.mode).toBe('resume-blocked');
    expect(session.getSnapshot().output.join('\n')).toContain(`任务 #${blockedTask.id} 已解除阻塞`);
    expect(llmBridge.resolveTaskResumeIntent).toHaveBeenCalledTimes(1);
    expect(llmBridge.resolveRoute).not.toHaveBeenCalled();
    expect(llmBridge.resolveIntent).not.toHaveBeenCalled();
  });
});
