import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
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
    expect(onDispatch).toHaveBeenCalledWith(urgentTaskId, { missingExecutionRequest: true });
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

  it('preempts the current task when semantic priority is urgent', async () => {
    const currentTaskId = createReadyTask({ title: '普通任务', progressRatio: 0.4 });
    const scheduler = new SchedulerEngine(taskEngine, orchestration, executor);
    await scheduler.scheduleNext();

    const urgentTaskId = createReadyTask({ title: '临时紧急任务', progressRatio: 0.1 });
    const urgentTask = taskRepo.findById(urgentTaskId)!;
    taskRepo.update(urgentTaskId, {
      prioritySignals: {
        ...urgentTask.prioritySignals,
        semanticPriority: 'urgent',
        semanticPriorityReason: '用户语义上要求插队处理临时任务',
      },
    });
    const result = await scheduler.submit(urgentTaskId, '用户语义上要求优先处理');

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

  it('promotes an executable parked task back to ready and schedules it before later normal ready tasks', async () => {
    const interruptedTaskId = createReadyTask({ title: '被抢占主线任务', progressRatio: 0.6 });
    const scheduler = new SchedulerEngine(taskEngine, orchestration, executor);
    await scheduler.scheduleNext();

    const urgentTaskId = createReadyTask({
      title: '高优插入任务',
      dueAt: '2026-04-16T01:00:00Z',
      progressRatio: 0.9,
      blocksOthers: true,
    });
    const urgentTask = taskRepo.findById(urgentTaskId)!;
    taskRepo.update(urgentTaskId, {
      prioritySignals: {
        ...urgentTask.prioritySignals,
        semanticPriority: 'urgent',
        semanticPriorityReason: '用户语义上要求插队处理临时任务',
      },
    });
    await scheduler.submit(urgentTaskId, '用户语义上要求优先处理');

    const laterNormalTaskId = createReadyTask({ title: '后续普通任务', progressRatio: 0.2 });
    taskEngine.transition(urgentTaskId, 'done');

    const nextTaskId = await scheduler.scheduleNext();

    expect(nextTaskId).toBe(interruptedTaskId);
    expect(taskRepo.findById(interruptedTaskId)?.status).toBe('running');
    expect(taskRepo.findById(interruptedTaskId)?.lastSchedulingReason).toBe('挂起任务满足执行条件，恢复进入待调度队列');
    expect(taskRepo.findById(laterNormalTaskId)?.status).toBe('ready');
  });

  it('auto-promotes manually parked tasks when they are executable', async () => {
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

    expect(nextTaskId).toBe(parkedTaskId);
    expect(taskRepo.findById(parkedTaskId)?.status).toBe('running');
    expect(taskRepo.findById(parkedTaskId)?.lastSchedulingReason).toBe('挂起任务满足执行条件，恢复进入待调度队列');
    expect(taskRepo.findById(readyTaskId)?.status).toBe('ready');
  });

  it('does not auto-promote parked tasks that are not ready to execute', async () => {
    const parkedTaskId = createReadyTask({ title: '等待材料的挂起任务', progressRatio: 0.7 });
    const scheduler = new SchedulerEngine(taskEngine, orchestration, executor);
    await scheduler.scheduleNext();

    taskEngine.park(parkedTaskId, '等待材料', {
      done: ['完成一部分'],
      pending: ['等待材料后继续'],
      nextStep: '等待用户补充材料',
      pauseReason: '等待材料',
    });
    taskRepo.update(parkedTaskId, {
      prioritySignals: {
        dueAt: null,
        isReady: false,
        progressRatio: 0.7,
        blocksOthers: false,
        idleHours: 0,
      },
    });

    const readyTaskId = createReadyTask({ title: '正常待执行任务', progressRatio: 0.1 });

    const nextTaskId = await scheduler.scheduleNext();

    expect(nextTaskId).toBe(readyTaskId);
    expect(taskRepo.findById(parkedTaskId)?.status).toBe('parked');
    expect(taskRepo.findById(readyTaskId)?.status).toBe('running');
  });

  it('runs semantically urgent parked tasks before other executable parked tasks', async () => {
    const normalParkedId = createReadyTask({ title: '中国谁做 harness 做的最好？', progressRatio: 0.1 });
    const urgentParkedId = createReadyTask({
      title: '插入一个紧急任务啊，美国有没有 harness 做的比较好的项目？',
      progressRatio: 0.1,
    });

    const scheduler = new SchedulerEngine(taskEngine, orchestration, executor);
    const normalTask = taskRepo.findById(normalParkedId)!;
    taskRepo.update(normalParkedId, {
      prioritySignals: {
        ...normalTask.prioritySignals,
        semanticPriority: 'normal',
        semanticPriorityReason: '顺序执行即可',
      },
    });
    const urgentTask = taskRepo.findById(urgentParkedId)!;
    taskRepo.update(urgentParkedId, {
      prioritySignals: {
        ...urgentTask.prioritySignals,
        semanticPriority: 'urgent',
        semanticPriorityReason: '用户语义上要求插队处理临时紧急任务',
      },
    });
    taskEngine.transition(normalParkedId, 'running');
    taskEngine.park(normalParkedId, '等待恢复', {
      done: [],
      pending: ['继续调研'],
      nextStep: '继续调研',
      pauseReason: '等待恢复',
    });
    taskEngine.transition(urgentParkedId, 'running');
    taskEngine.park(urgentParkedId, '等待恢复', {
      done: [],
      pending: ['继续调研'],
      nextStep: '继续调研',
      pauseReason: '等待恢复',
    });

    const nextTaskId = await scheduler.scheduleNext();

    expect(nextTaskId).toBe(urgentParkedId);
    expect(taskRepo.findById(urgentParkedId)?.status).toBe('running');
    expect(taskRepo.findById(normalParkedId)?.status).toBe('ready');
  });

  it('classifies missing semantic priority before promoting parked tasks', async () => {
    const normalParkedId = createReadyTask({ title: '按顺序整理中国 harness 项目', progressRatio: 0.1 });
    const urgentParkedId = createReadyTask({
      title: '客户马上要看，先处理美国 harness 项目对比',
      progressRatio: 0.1,
    });

    taskEngine.transition(normalParkedId, 'running');
    taskEngine.park(normalParkedId, '等待恢复', {
      done: [],
      pending: ['继续调研'],
      nextStep: '继续调研',
      pauseReason: '等待恢复',
    });
    taskEngine.transition(urgentParkedId, 'running');
    taskEngine.park(urgentParkedId, '等待恢复', {
      done: [],
      pending: ['继续调研'],
      nextStep: '继续调研',
      pauseReason: '等待恢复',
    });

    const classifyPrioritySignals = vi.fn((tasks) => {
      for (const task of tasks) {
        const current = taskRepo.findById(task.id)!;
        taskRepo.update(task.id, {
          prioritySignals: {
            ...current.prioritySignals,
            semanticPriority: task.id === urgentParkedId ? 'urgent' : 'normal',
            semanticPriorityReason: task.id === urgentParkedId
              ? '语义上有明确时间压力，需要先处理'
              : '顺序执行即可',
          },
        });
      }
    });
    const scheduler = new SchedulerEngine(
      taskEngine,
      orchestration,
      executor,
      undefined,
      classifyPrioritySignals,
    );

    const nextTaskId = await scheduler.scheduleNext();

    expect(classifyPrioritySignals).toHaveBeenCalledTimes(1);
    expect(classifyPrioritySignals).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: normalParkedId }),
      expect.objectContaining({ id: urgentParkedId }),
    ]));
    expect(nextTaskId).toBe(urgentParkedId);
    expect(taskRepo.findById(urgentParkedId)?.prioritySignals.semanticPriority).toBe('urgent');
    expect(taskRepo.findById(urgentParkedId)?.status).toBe('running');
    expect(taskRepo.findById(normalParkedId)?.status).toBe('ready');
  });

  it('owns active dispatch tracking and waitForIdle lifecycle', async () => {
    const taskId = createReadyTask({ title: '异步派发任务' });
    let releaseDispatch!: () => void;
    let dispatchCompleted = false;
    const onDispatch = vi.fn(() => new Promise<void>(resolve => {
      releaseDispatch = () => {
        dispatchCompleted = true;
        resolve();
      };
    }));
    const scheduler = new SchedulerEngine(taskEngine, orchestration, executor, onDispatch);

    await scheduler.scheduleNext();

    let idle = false;
    const idlePromise = scheduler.waitForIdle().then(() => {
      idle = true;
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(idle).toBe(false);
    expect(dispatchCompleted).toBe(false);

    releaseDispatch();
    await idlePromise;

    expect(idle).toBe(true);
    expect(dispatchCompleted).toBe(true);
  });

  it('waits for dispatches that are active when waitForIdle starts without self-waiting on chained dispatches', async () => {
    const firstTaskId = createReadyTask({
      title: '当前运行任务',
      dueAt: '2026-04-16T01:00:00Z',
      progressRatio: 0.8,
      blocksOthers: true,
    });
    const secondTaskId = createReadyTask({ title: '后续排队任务' });
    const dispatches: string[] = [];
    let scheduler!: SchedulerEngine;
    const onDispatch = vi.fn(async taskId => {
      dispatches.push(taskId);
      if (taskId === firstTaskId) {
        await scheduler.markDispatchFinished(firstTaskId, {
          taskId: firstTaskId,
          executionId: 'exec_first',
          status: 'success',
          reason: 'first done',
        });
      }
    });
    scheduler = new SchedulerEngine(taskEngine, orchestration, executor, onDispatch);

    await scheduler.scheduleNext();
    await scheduler.submit(secondTaskId, { reason: '排队执行' });
    await scheduler.waitForIdle();

    expect(dispatches).toEqual([firstTaskId, secondTaskId]);
    expect(taskRepo.findById(firstTaskId)?.status).toBe('done');
    expect(taskRepo.findById(secondTaskId)?.status).toBe('running');
  });

  it('owns queued execution requests and passes them to dispatch when a queued task later starts', async () => {
    const runningTaskId = createReadyTask({
      title: '当前运行任务',
      dueAt: '2026-04-16T01:00:00Z',
      progressRatio: 0.8,
      blocksOthers: true,
    });
    const queuedTaskId = createReadyTask({ title: '待派发任务' });
    const dispatches: Array<{ taskId: string; request?: { userPrompt: string }; missing?: boolean }> = [];
    const scheduler = new SchedulerEngine<{ userPrompt: string }>(
      taskEngine,
      orchestration,
      executor,
      (taskId, context) => {
        dispatches.push({
          taskId,
          request: context?.executionRequest,
          missing: context?.missingExecutionRequest,
        });
      },
    );
    await scheduler.scheduleNext();

    const submitResult = await scheduler.submit(queuedTaskId, {
      reason: '排队执行',
      executionRequest: { userPrompt: '实现排队任务' },
    });
    taskEngine.transition(runningTaskId, 'done');

    const scheduledTaskId = await scheduler.scheduleNext();

    expect(submitResult.action).toBe('queued');
    expect(scheduledTaskId).toBe(queuedTaskId);
    expect(dispatches).toEqual([
      { taskId: runningTaskId, request: undefined, missing: true },
      { taskId: queuedTaskId, request: { userPrompt: '实现排队任务' }, missing: false },
    ]);
  });

  it('marks dispatch finished and schedules the next queued task through the bridge contract', async () => {
    const runningTaskId = createReadyTask({
      title: '当前运行任务',
      dueAt: '2026-04-16T01:00:00Z',
      progressRatio: 0.8,
      blocksOthers: true,
    });
    const queuedTaskId = createReadyTask({ title: '后续任务' });
    const dispatches: string[] = [];
    const scheduler = new SchedulerEngine(
      taskEngine,
      orchestration,
      executor,
      taskId => {
        dispatches.push(taskId);
      },
    );
    await scheduler.scheduleNext();
    await scheduler.submit(queuedTaskId, { reason: '排队执行' });

    await scheduler.markDispatchFinished(runningTaskId, {
      taskId: runningTaskId,
      executionId: 'exec_1',
      status: 'success',
      reason: 'done',
    });

    expect(taskRepo.findById(runningTaskId)?.status).toBe('done');
    expect(taskRepo.findById(queuedTaskId)?.status).toBe('running');
    expect(dispatches).toEqual([runningTaskId, queuedTaskId]);
  });

  it('marks dispatch blocked and schedules the next queued task through the bridge contract', async () => {
    const runningTaskId = createReadyTask({
      title: '当前运行任务',
      dueAt: '2026-04-16T01:00:00Z',
      progressRatio: 0.8,
      blocksOthers: true,
    });
    const queuedTaskId = createReadyTask({ title: '后续任务' });
    const dispatches: string[] = [];
    const scheduler = new SchedulerEngine(
      taskEngine,
      orchestration,
      executor,
      taskId => {
        dispatches.push(taskId);
      },
    );
    await scheduler.scheduleNext();
    await scheduler.submit(queuedTaskId, { reason: '排队执行' });

    await scheduler.markDispatchBlocked(runningTaskId, '等待测试证据');

    expect(taskRepo.findById(runningTaskId)?.status).toBe('blocked');
    expect(taskRepo.findById(runningTaskId)?.dependencies).toEqual([
      expect.objectContaining({
        description: '等待测试证据',
        status: 'waiting',
      }),
    ]);
    expect(taskRepo.findById(queuedTaskId)?.status).toBe('running');
    expect(dispatches).toEqual([runningTaskId, queuedTaskId]);
  });

  it('does not auto-resume a task parked because execution failed', async () => {
    const failedTaskId = createReadyTask({ title: '失败后挂起任务' });
    const scheduler = new SchedulerEngine(taskEngine, orchestration, executor);
    await scheduler.scheduleNext();

    taskEngine.park(failedTaskId, '执行失败: 普通失败', {
      done: [],
      pending: ['失败后等待用户处理'],
      nextStep: '检查失败原因后手动恢复',
      pauseReason: '执行失败: 普通失败',
    });

    const nextTaskId = await scheduler.scheduleNext();

    expect(nextTaskId).toBeNull();
    expect(taskRepo.findById(failedTaskId)?.status).toBe('parked');
  });
});
