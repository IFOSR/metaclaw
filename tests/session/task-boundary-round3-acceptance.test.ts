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
});
