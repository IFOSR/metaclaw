import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { tasksCommand } from '../../src/commands/task-commands.js';
import type { CommandContext } from '../../src/commands/router.js';
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';

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

describe('tasksCommand', () => {
  let taskEngine: TaskEngine;
  let taskRepo: TaskRepo;
  let context: CommandContext;

  beforeEach(() => {
    const db = createTestDb();
    taskRepo = new TaskRepo(db);
    taskEngine = new TaskEngine(taskRepo, resolve(tmpdir(), 'metaclaw-test-snapshots'));
    const orchestration = new OrchestrationEngine(taskEngine);
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: async () => ({ success: true, output: '', exitCode: 0, durationMs: 0 }),
      isAvailable: async () => true,
      abort: () => {},
    };

    context = {
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      currentTaskId: null,
      db,
      config: createConfig(),
    };
  });

  it('groups tasks by running, ready, parked, blocked, and done in the default list', async () => {
    const runningTask = taskEngine.create({ title: '执行中的任务', goal: '执行中' });
    taskEngine.transition(runningTask.id, 'ready');
    taskEngine.transition(runningTask.id, 'running');

    const readyTask = taskEngine.create({ title: '待执行任务', goal: '待执行' });
    taskEngine.transition(readyTask.id, 'ready');

    const parkedTask = taskEngine.create({ title: '已挂起任务', goal: '已挂起' });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '用户暂停', {
      done: [],
      pending: ['继续'],
      nextStep: '继续',
      pauseReason: '用户暂停',
    });

    const blockedTask = taskEngine.create({ title: '已阻塞任务', goal: '已阻塞' });
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '等待资料',
      status: 'waiting',
    });

    const doneTask = taskEngine.create({ title: '已完成任务', goal: '已完成' });
    taskEngine.transition(doneTask.id, 'ready');
    taskEngine.transition(doneTask.id, 'running');
    taskEngine.transition(doneTask.id, 'done');

    const result = await tasksCommand.execute([], context);

    expect(result.content).toContain('当前执行');
    expect(result.content).toContain('待执行');
    expect(result.content).toContain('已挂起');
    expect(result.content).toContain('已阻塞');
    expect(result.content).toContain('已完成');
  });

  it('supports ready and parked filters', async () => {
    const readyTask = taskEngine.create({ title: '待执行任务', goal: '待执行' });
    taskEngine.transition(readyTask.id, 'ready');

    const parkedTask = taskEngine.create({ title: '已挂起任务', goal: '已挂起' });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '用户暂停', {
      done: [],
      pending: ['继续'],
      nextStep: '继续',
      pauseReason: '用户暂停',
    });

    const readyResult = await tasksCommand.execute(['ready'], context);
    expect(readyResult.content).toContain(readyTask.id);
    expect(readyResult.content).not.toContain(parkedTask.id);

    const parkedResult = await tasksCommand.execute(['parked'], context);
    expect(parkedResult.content).toContain(parkedTask.id);
    expect(parkedResult.content).not.toContain(readyTask.id);
  });

  it('hides historical non-task chatter from the default task list', async () => {
    const realTask = taskEngine.create({ title: '行业调研任务', goal: '输出调研结论' });
    taskEngine.transition(realTask.id, 'ready');
    taskEngine.transition(realTask.id, 'running');
    taskEngine.transition(realTask.id, 'done');

    const chatterTask = taskEngine.create({ title: 'hi', goal: 'hi' });
    taskEngine.transition(chatterTask.id, 'ready');
    taskEngine.transition(chatterTask.id, 'running');
    taskEngine.transition(chatterTask.id, 'done');

    const result = await tasksCommand.execute([], context);

    expect(result.content).toContain(realTask.id);
    expect(result.content).not.toContain(chatterTask.id);
    expect(result.content).not.toContain('[DONE] hi');
  });

  it('clears only parked tasks when requested', async () => {
    const readyTask = taskEngine.create({ title: '待执行任务', goal: '待执行' });
    taskEngine.transition(readyTask.id, 'ready');

    const parkedTask = taskEngine.create({ title: '已挂起任务', goal: '已挂起' });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '用户暂停', {
      done: [],
      pending: ['继续'],
      nextStep: '继续',
      pauseReason: '用户暂停',
    });

    const result = await tasksCommand.execute(['clear', 'parked'], context);

    expect(result.content).toContain('已清空挂起任务：取消 1 个任务');
    expect(result.content).toContain(parkedTask.id);
    expect(taskRepo.findById(parkedTask.id)?.status).toBe('cancelled');
    expect(taskRepo.findById(readyTask.id)?.status).toBe('ready');
  });

  it('clears all manageable tasks and leaves completed history untouched', async () => {
    const runningTask = taskEngine.create({ title: '执行中的任务', goal: '执行中' });
    taskEngine.transition(runningTask.id, 'ready');
    taskEngine.transition(runningTask.id, 'running');

    const blockedTask = taskEngine.create({ title: '已阻塞任务', goal: '已阻塞' });
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '等待资料',
      status: 'waiting',
    });

    const doneTask = taskEngine.create({ title: '已完成任务', goal: '已完成' });
    taskEngine.transition(doneTask.id, 'ready');
    taskEngine.transition(doneTask.id, 'running');
    taskEngine.transition(doneTask.id, 'done');

    const result = await tasksCommand.execute(['clear', 'all'], context);

    expect(result.content).toContain('已清空所有未完成任务：取消 2 个任务');
    expect(result.content).toContain('已中止当前执行器');
    expect(taskRepo.findById(runningTask.id)?.status).toBe('cancelled');
    expect(taskRepo.findById(blockedTask.id)?.status).toBe('cancelled');
    expect(taskRepo.findById(doneTask.id)?.status).toBe('done');
  });
});
