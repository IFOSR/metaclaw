import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { OrchestrationEngine } from '../../src/core/orchestration.js';
import { SchedulerEngine } from '../../src/core/scheduler.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('SchedulerEngine', () => {
  let taskEngine: TaskEngine;
  let taskRepo: TaskRepo;
  let orchestration: OrchestrationEngine;
  let executor: ExecutorAdapter;

  beforeEach(() => {
    const db = createTestDb();
    taskRepo = new TaskRepo(db);
    taskEngine = new TaskEngine(taskRepo, resolve(tmpdir(), 'metaclaw-test-snapshots'));
    orchestration = new OrchestrationEngine(taskEngine);
    executor = {
      name: 'codex-cli',
      execute: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
  });

  function createReadyTask(input: {
    title: string;
    dueAt?: string | null;
    progressRatio?: number;
    blocksOthers?: boolean;
  }) {
    const task = taskEngine.create({ title: input.title, goal: input.title });
    taskRepo.update(task.id, {
      prioritySignals: {
        dueAt: input.dueAt ?? null,
        isReady: true,
        progressRatio: input.progressRatio ?? 0,
        blocksOthers: input.blocksOthers ?? false,
        idleHours: 0,
      },
    });
    taskEngine.transition(task.id, 'ready');
    return task.id;
  }

  it('runs the highest-priority ready task when idle', async () => {
    const normalTaskId = createReadyTask({ title: '普通任务' });
    const urgentTaskId = createReadyTask({
      title: '紧急任务',
      dueAt: '2026-04-16T01:00:00Z',
      progressRatio: 0.8,
      blocksOthers: true,
    });

    const scheduler = new SchedulerEngine(taskEngine, orchestration, executor);
    const scheduledTaskId = await scheduler.scheduleNext();

    expect(scheduledTaskId).toBe(urgentTaskId);
    expect(taskRepo.findById(urgentTaskId)?.status).toBe('running');
    expect(taskRepo.findById(normalTaskId)?.status).toBe('ready');
    expect(scheduler.getRuntimeState().runningTaskId).toBe(urgentTaskId);
  });

  it('promotes and runs the highest-priority created backlog task when idle', async () => {
    const normalTaskId = taskEngine.create({ title: '普通已创建任务', goal: '普通已创建任务' }).id;
    const urgentTaskId = taskEngine.create({ title: '紧急已创建任务', goal: '紧急已创建任务' }).id;
    taskRepo.update(urgentTaskId, {
      prioritySignals: {
        dueAt: '2026-04-16T01:00:00Z',
        isReady: true,
        progressRatio: 0.8,
        blocksOthers: true,
        idleHours: 0,
      },
    });
    const onDispatch = vi.fn();
    const scheduler = new SchedulerEngine(taskEngine, orchestration, executor, onDispatch);

    const scheduledTaskId = await scheduler.scheduleNext();

    expect(scheduledTaskId).toBe(urgentTaskId);
    expect(taskRepo.findById(urgentTaskId)?.status).toBe('running');
    expect(taskRepo.findById(normalTaskId)?.status).toBe('created');
    expect(onDispatch).toHaveBeenCalledWith(urgentTaskId, undefined);
  });

  it('parks the current task when a higher-priority task arrives', async () => {
    const currentTaskId = createReadyTask({ title: '当前任务' });
    const scheduler = new SchedulerEngine(taskEngine, orchestration, executor);
    await scheduler.scheduleNext();

    const urgentTaskId = createReadyTask({
      title: '插队任务',
      dueAt: '2026-04-16T01:00:00Z',
      progressRatio: 0.9,
      blocksOthers: true,
    });

    const result = await scheduler.submit(urgentTaskId, '截止时间临近');

    expect(result.action).toBe('preempted');
    expect(taskRepo.findById(currentTaskId)?.status).toBe('parked');
    expect(taskRepo.findById(currentTaskId)?.lastInterruptionReason).toContain('截止时间临近');
    expect(taskRepo.findById(urgentTaskId)?.status).toBe('running');
    expect(executor.abort).toHaveBeenCalledTimes(1);
  });

  it('preempts the current task when an explicit urgent priority hint is provided', async () => {
    const currentTaskId = createReadyTask({ title: '普通任务', progressRatio: 0.4 });
    const scheduler = new SchedulerEngine(taskEngine, orchestration, executor);
    await scheduler.scheduleNext();

    const urgentTaskId = createReadyTask({ title: '临时紧急任务', progressRatio: 0.1 });
    const result = await scheduler.submit(urgentTaskId, {
      reason: '用户显式要求优先处理',
      priorityHint: 'urgent',
    });

    expect(result.action).toBe('preempted');
    expect(result.preemptedTaskId).toBe(currentTaskId);
    expect(taskRepo.findById(currentTaskId)?.status).toBe('parked');
    expect(taskRepo.findById(urgentTaskId)?.status).toBe('running');
  });

  it('skips blocked tasks and runs the next ready task', async () => {
    const blockedTaskId = createReadyTask({
      title: '被阻塞任务',
      dueAt: '2026-04-16T01:00:00Z',
      progressRatio: 1,
      blocksOthers: true,
    });
    taskEngine.transition(blockedTaskId, 'running');
    taskEngine.block(blockedTaskId, {
      taskId: blockedTaskId,
      type: 'manual',
      description: '等待客户资料',
      status: 'waiting',
    });

    const readyTaskId = createReadyTask({ title: '可执行任务', progressRatio: 0.2 });
    const scheduler = new SchedulerEngine(taskEngine, orchestration, executor);
    const scheduledTaskId = await scheduler.scheduleNext();

    expect(scheduledTaskId).toBe(readyTaskId);
    expect(taskRepo.findById(blockedTaskId)?.status).toBe('blocked');
    expect(taskRepo.findById(readyTaskId)?.status).toBe('running');
  });

  it('promotes a preempted parked task back to ready and schedules it before later normal ready tasks', async () => {
    const interruptedTaskId = createReadyTask({ title: '被抢占主线任务', progressRatio: 0.6 });
    const scheduler = new SchedulerEngine(taskEngine, orchestration, executor);
    await scheduler.scheduleNext();

    const urgentTaskId = createReadyTask({
      title: '高优插入任务',
      dueAt: '2026-04-16T01:00:00Z',
      progressRatio: 0.9,
      blocksOthers: true,
    });
    await scheduler.submit(urgentTaskId, {
      reason: '用户显式要求优先处理',
      priorityHint: 'urgent',
    });

    const laterNormalTaskId = createReadyTask({ title: '后续普通任务', progressRatio: 0.2 });
    taskEngine.transition(urgentTaskId, 'done');

    const nextTaskId = await scheduler.scheduleNext();

    expect(nextTaskId).toBe(interruptedTaskId);
    expect(taskRepo.findById(interruptedTaskId)?.status).toBe('running');
    expect(taskRepo.findById(interruptedTaskId)?.lastSchedulingReason).toBe('高优任务完成，恢复进入待调度队列');
    expect(taskRepo.findById(laterNormalTaskId)?.status).toBe('ready');
  });

  it('does not auto-promote manually parked tasks when scheduling the next task', async () => {
    const parkedTaskId = createReadyTask({ title: '手动挂起任务', progressRatio: 0.7 });
    const scheduler = new SchedulerEngine(taskEngine, orchestration, executor);
    await scheduler.scheduleNext();

    taskEngine.park(parkedTaskId, '用户手动暂停', {
      done: ['完成一部分'],
      pending: ['继续推进'],
      nextStep: '等待用户恢复',
      pauseReason: '用户手动暂停',
    });

    const readyTaskId = createReadyTask({ title: '正常待执行任务', progressRatio: 0.1 });

    const nextTaskId = await scheduler.scheduleNext();

    expect(nextTaskId).toBe(readyTaskId);
    expect(taskRepo.findById(parkedTaskId)?.status).toBe('parked');
    expect(taskRepo.findById(readyTaskId)?.status).toBe('running');
  });
});
