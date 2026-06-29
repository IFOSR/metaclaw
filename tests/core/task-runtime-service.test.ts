import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { TaskRuntimeService } from '../../src/core/task-runtime-service.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('TaskRuntimeService', () => {
  let taskRepo: TaskRepo;
  let taskEngine: TaskEngine;
  let orchestration: OrchestrationEngine;
  let executor: ExecutorAdapter;
  let service: TaskRuntimeService;

  beforeEach(() => {
    const db = createTestDb();
    taskRepo = new TaskRepo(db);
    taskEngine = new TaskEngine(taskRepo, resolve(tmpdir(), 'metaclaw-task-runtime-tests'));
    orchestration = new OrchestrationEngine(taskEngine);
    executor = {
      name: 'codex-cli',
      execute: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    service = new TaskRuntimeService({ taskEngine, taskRepo, orchestration });
  });

  it('normalizes created and parked tasks into ready tasks for scheduling', () => {
    const createdTask = taskEngine.create({ title: 'created', goal: 'created' });
    const parkedTask = taskEngine.create({ title: 'parked', goal: 'parked' });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, 'pause', {
      done: [],
      pending: ['continue'],
      nextStep: 'continue',
      pauseReason: 'pause',
    });

    expect(service.normalizeTaskForScheduling(createdTask.id).status).toBe('ready');
    expect(service.normalizeTaskForScheduling(parkedTask.id).status).toBe('ready');
  });

  it('starts dispatch by transitioning a ready task to running and recording the scheduling reason', () => {
    const task = taskEngine.create({ title: 'run me', goal: 'run me' });

    const running = service.startDispatch(task.id, 'highest priority');

    expect(running.status).toBe('running');
    expect(taskRepo.findById(task.id)?.lastSchedulingReason).toBe('highest priority');
  });

  it('parks the current task when preempting without aborting executors directly', () => {
    const current = taskEngine.create({ title: 'current', goal: 'current goal' });
    taskEngine.transition(current.id, 'ready');
    taskEngine.transition(current.id, 'running');

    const parked = service.preemptCurrentTask('urgent task arrived');

    expect(parked?.status).toBe('parked');
    expect(parked?.lastInterruptionReason).toContain('urgent task arrived');
    expect(parked?.interruptionCount).toBe(1);
    expect(executor.abort).not.toHaveBeenCalled();
  });

  it('clears tasks with structured data and leaves abort/presentation to outer boundaries', () => {
    const runningTask = taskEngine.create({ title: 'running', goal: 'running' });
    taskEngine.transition(runningTask.id, 'ready');
    taskEngine.transition(runningTask.id, 'running');

    const result = service.clearTasks('all');

    expect(result.cancelled.map(task => task.id)).toEqual([runningTask.id]);
    expect(result.runningCancelled).toBe(true);
    expect('output' in result).toBe(false);
    expect(executor.abort).not.toHaveBeenCalled();
  });

  it('promotes executable parked tasks and leaves blocked-input parked tasks alone', async () => {
    const readyParked = taskEngine.create({ title: 'ready parked', goal: 'ready parked' });
    taskEngine.transition(readyParked.id, 'ready');
    taskEngine.transition(readyParked.id, 'running');
    taskEngine.park(readyParked.id, 'pause', {
      done: [],
      pending: ['continue'],
      nextStep: 'continue',
      pauseReason: 'pause',
    });

    const waitingParked = taskEngine.create({ title: 'waiting parked', goal: 'waiting parked' });
    taskEngine.transition(waitingParked.id, 'ready');
    taskEngine.transition(waitingParked.id, 'running');
    taskEngine.park(waitingParked.id, 'waiting material', {
      done: [],
      pending: ['wait'],
      nextStep: 'wait',
      pauseReason: 'waiting material',
    });
    taskRepo.update(waitingParked.id, {
      prioritySignals: {
        ...taskRepo.findById(waitingParked.id)!.prioritySignals,
        isReady: false,
      },
    });

    const promoted = await service.promoteAutoResumableParkedTasks();

    expect(promoted.map(task => task.id)).toEqual([readyParked.id]);
    expect(taskRepo.findById(readyParked.id)?.status).toBe('ready');
    expect(taskRepo.findById(waitingParked.id)?.status).toBe('parked');
  });

  it('returns the next schedulable task with resume context for auto-promoted parked work', async () => {
    const parked = taskEngine.create({ title: 'parked work', goal: 'parked work' });
    taskEngine.transition(parked.id, 'ready');
    taskEngine.transition(parked.id, 'running');
    taskEngine.park(parked.id, 'pause', {
      done: [],
      pending: ['continue'],
      nextStep: 'continue',
      pauseReason: 'pause',
    });
    await service.promoteAutoResumableParkedTasks();

    const next = service.getNextSchedulableTask();

    expect(next?.task.id).toBe(parked.id);
    expect(next?.priority).toBe('normal');
    expect(next?.dispatchContext?.executionMode).toBe('resume-parked');
  });

  it('executes lifecycle commands with a standard TaskRuntimeResult contract', () => {
    const created = service.execute({
      type: 'create',
      input: { title: 'command task', goal: 'command task' },
    });

    expect(created.status).toBe('ok');
    expect(created.task?.status).toBe('created');

    const updated = service.execute({
      type: 'update',
      taskId: created.task!.id,
      changes: { summary: 'updated through command' },
    });

    expect(updated.status).toBe('ok');
    expect(updated.task?.summary).toBe('updated through command');

    const started = service.execute({
      type: 'start_dispatch',
      taskId: created.task!.id,
      reason: 'command dispatch',
    });

    expect(started.status).toBe('ok');
    expect(started.task?.status).toBe('running');

    const blocked = service.execute({
      type: 'block',
      taskId: created.task!.id,
      dependency: {
        taskId: created.task!.id,
        type: 'manual',
        description: 'waiting for material',
        status: 'waiting',
      },
    });

    expect(blocked.status).toBe('ok');
    expect(blocked.task?.status).toBe('blocked');

    const missing = service.execute({ type: 'find', taskId: 'missing' });
    expect(missing.status).toBe('not_found');
    expect(missing.task).toBeNull();
  });

  it('owns current task and focus context state', () => {
    const task = taskEngine.create({ title: 'focused', goal: 'focused' });

    service.setCurrentTaskId(task.id);
    service.setFocusContext({ kind: 'task', taskId: task.id });

    expect(service.getCurrentTaskId()).toBe(task.id);
    expect(service.getFocusContext()).toEqual({ kind: 'task', taskId: task.id });

    service.setFocusContext({ kind: 'conversation', taskId: null });
    expect(service.getFocusContext()).toEqual({ kind: 'conversation', taskId: null });

    service.setCurrentTaskId(null);
    service.setFocusContext(null);
    expect(service.getCurrentTaskId()).toBeNull();
    expect(service.getFocusContext()).toBeNull();
  });
});
