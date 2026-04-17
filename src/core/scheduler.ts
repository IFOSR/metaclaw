import type { ExecutorAdapter } from '../executor/adapter.js';
import type { RuntimeState, Task } from './types.js';
import type { TaskEngine } from './task-engine.js';
import type { OrchestrationEngine } from './orchestration.js';

const PREEMPT_DELTA = 5;

export interface SubmitResult {
  action: 'started' | 'queued' | 'preempted';
  taskId: string;
  preemptedTaskId?: string;
}

export interface SubmitOptions {
  reason: string;
  priorityHint?: 'normal' | 'high' | 'urgent';
}

export class SchedulerEngine {
  private lastEvent: string | null = null;

  constructor(
    private taskEngine: TaskEngine,
    private orchestration: OrchestrationEngine,
    private executor: ExecutorAdapter,
    private onDispatch?: (taskId: string) => Promise<void> | void,
  ) {}

  async scheduleNext(): Promise<string | null> {
    const currentTask = this.getCurrentRunningTask();
    if (currentTask) return currentTask.id;

    const prioritized = this.orchestration.getPrioritizedTasks();
    if (prioritized.length === 0) return null;

    const next = prioritized[0];
    await this.startTask(next.task.id, next.reasons[0] || '最高优先级任务');
    return next.task.id;
  }

  async submit(taskId: string, input: string | SubmitOptions): Promise<SubmitResult> {
    const submitOptions = typeof input === 'string' ? { reason: input, priorityHint: 'normal' as const } : input;
    const { reason, priorityHint } = submitOptions;
    const repo = this.taskEngine['taskRepo'];
    const task = repo.findById(taskId);
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`);
    }

    this.normalizeTaskForScheduling(task);

    const currentTask = this.getCurrentRunningTask();
    if (!currentTask) {
      await this.startTask(taskId, reason);
      return { action: 'started', taskId };
    }

    const candidateTask = repo.findById(taskId)!;
    if (candidateTask.status !== 'ready') {
      repo.update(taskId, { lastSchedulingReason: reason });
      this.lastEvent = `任务 #${taskId} 当前状态为 ${candidateTask.status}，未进入候选队列`;
      return { action: 'queued', taskId };
    }

    if (this.shouldPreempt(currentTask, candidateTask, reason, priorityHint)) {
      await this.preemptWith(taskId, reason);
      return { action: 'preempted', taskId, preemptedTaskId: currentTask.id };
    }

    repo.update(taskId, { lastSchedulingReason: reason });
    this.lastEvent = `任务 #${taskId} 已进入候选队列`;
    return { action: 'queued', taskId };
  }

  async preemptWith(taskId: string, reason: string): Promise<void> {
    const currentTask = this.getCurrentRunningTask();
    const interruptionReason = `被更高优先级任务抢占：${reason}`;

    if (currentTask) {
      this.taskEngine.park(currentTask.id, interruptionReason, {
        done: currentTask.summary ? [currentTask.summary] : [],
        pending: [currentTask.goal],
        nextStep: '恢复后继续当前未完成步骤',
        pauseReason: interruptionReason,
      });
      this.taskEngine['taskRepo'].update(currentTask.id, {
        lastInterruptionReason: interruptionReason,
        interruptionCount: currentTask.interruptionCount + 1,
      });
      this.executor.abort();
    }

    await this.startTask(taskId, reason);
  }

  getRuntimeState(): RuntimeState {
    const repo = this.taskEngine['taskRepo'];
    return {
      runningTaskId: this.getCurrentRunningTask()?.id ?? null,
      readyTaskIds: repo.findByStatus('ready').map(task => task.id),
      blockedTaskIds: repo.findByStatus('blocked').map(task => task.id),
      parkedTaskIds: repo.findByStatus('parked').map(task => task.id),
      lastEvent: this.lastEvent,
    };
  }

  private normalizeTaskForScheduling(task: Task): void {
    if (task.status === 'created') {
      this.taskEngine.transition(task.id, 'ready');
      return;
    }

    if (task.status === 'parked') {
      this.taskEngine.transition(task.id, 'ready');
    }
  }

  private async startTask(taskId: string, reason: string): Promise<void> {
    const repo = this.taskEngine['taskRepo'];
    const task = repo.findById(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);

    if (task.status === 'created') {
      this.taskEngine.transition(taskId, 'ready');
    }

    const refreshed = repo.findById(taskId)!;
    if (refreshed.status === 'parked') {
      this.taskEngine.transition(taskId, 'ready');
    }

    const runnable = repo.findById(taskId)!;
    if (runnable.status === 'ready') {
      this.taskEngine.transition(taskId, 'running');
    }

    repo.update(taskId, { lastSchedulingReason: reason });
    this.lastEvent = `开始执行任务 #${taskId}`;

    if (this.onDispatch) {
      void Promise.resolve(this.onDispatch(taskId));
    }
  }

  private getCurrentRunningTask(): Task | null {
    return this.taskEngine['taskRepo'].findByStatus('running')[0] ?? null;
  }

  private shouldPreempt(
    currentTask: Task,
    candidateTask: Task,
    reason: string,
    priorityHint: SubmitOptions['priorityHint'],
  ): boolean {
    const currentScore = this.orchestration.evaluateTask(currentTask).score.total;
    const candidateScore = this.orchestration.evaluateTask(candidateTask).score.total;
    const hasManualPriorityHint = priorityHint === 'urgent' || /紧急|优先|立刻|马上/.test(reason);

    return hasManualPriorityHint || candidateScore >= currentScore + PREEMPT_DELTA;
  }
}
