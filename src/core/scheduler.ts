import type { ExecutorAdapter } from '../executor/adapter.js';
import type { RuntimeState, Task } from './types.js';
import type { TaskEngine } from './task-engine.js';
import type { OrchestrationEngine } from './orchestration.js';

const PREEMPT_DELTA = 5;
const AUTO_RESUME_READY_REASON = '挂起任务满足执行条件，恢复进入待调度队列';

export interface SubmitResult {
  action: 'started' | 'queued' | 'preempted';
  taskId: string;
  preemptedTaskId?: string;
}

export interface SubmitOptions {
  reason: string;
}

export interface DispatchContext {
  executionMode?: 'fresh' | 'resume-parked' | 'resume-blocked';
  schedulingReason?: string;
}

export class SchedulerEngine {
  private lastEvent: string | null = null;

  constructor(
    private taskEngine: TaskEngine,
    private orchestration: OrchestrationEngine,
    private executor: ExecutorAdapter,
    private onDispatch?: (taskId: string, context?: DispatchContext) => Promise<void> | void,
    private classifyPrioritySignals?: (tasks: Task[]) => Promise<void> | void,
  ) {}

  async scheduleNext(): Promise<string | null> {
    const currentTask = this.getCurrentRunningTask();
    if (currentTask) return currentTask.id;

    await this.promoteAutoResumableParkedTasks();

    const next = this.getNextSchedulableTask();
    if (!next) return null;

    await this.startTask(next.task.id, next.reason, next.dispatchContext);
    return next.task.id;
  }

  async submit(taskId: string, input: string | SubmitOptions): Promise<SubmitResult> {
    const submitOptions = typeof input === 'string' ? { reason: input } : input;
    const { reason } = submitOptions;
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

    if (this.shouldPreempt(currentTask, candidateTask)) {
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
      runningExecutorName: null,
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

  private async startTask(taskId: string, reason: string, dispatchContext?: DispatchContext): Promise<void> {
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
      void Promise.resolve(this.onDispatch(taskId, dispatchContext));
    }
  }

  private getCurrentRunningTask(): Task | null {
    return this.taskEngine['taskRepo'].findByStatus('running')[0] ?? null;
  }

  private shouldPreempt(
    currentTask: Task,
    candidateTask: Task,
  ): boolean {
    const currentScore = this.orchestration.evaluateTask(currentTask).score.total;
    const candidateScore = this.orchestration.evaluateTask(candidateTask).score.total;
    const hasExplicitSemanticPriority = candidateTask.prioritySignals.semanticPriority === 'urgent';

    return hasExplicitSemanticPriority || candidateScore >= currentScore + PREEMPT_DELTA;
  }

  private getNextSchedulableTask():
    | { task: Task; reason: string; dispatchContext?: DispatchContext }
    | null {
    const prioritized = this.orchestration.getPrioritizedTasks();
    if (prioritized.length === 0) return null;

    const task = prioritized[0].task;
    const schedulingReason = this.isAutoResumableReadyTask(task)
      ? task.lastSchedulingReason || AUTO_RESUME_READY_REASON
      : prioritized[0].reasons[0] || '最高优先级任务';

    return {
      task,
      reason: schedulingReason,
      dispatchContext: this.isAutoResumableReadyTask(task)
        ? {
            executionMode: 'resume-parked',
            schedulingReason,
          }
        : undefined,
    };
  }

  private async promoteAutoResumableParkedTasks(): Promise<void> {
    const repo = this.taskEngine['taskRepo'];
    const candidates = repo
      .findByStatus('parked')
      .filter(task => this.isAutoResumableParkedTask(task));

    if (this.classifyPrioritySignals) {
      await Promise.resolve(this.classifyPrioritySignals(candidates));
    }

    for (const task of candidates) {
      const refreshed = repo.findById(task.id);
      if (!refreshed || refreshed.status !== 'parked') {
        continue;
      }

      this.taskEngine.transition(task.id, 'ready');
      repo.update(task.id, {
        lastSchedulingReason: AUTO_RESUME_READY_REASON,
      });
      this.lastEvent = `任务 #${task.id} 已从挂起恢复到待调度队列`;
    }
  }

  private isAutoResumableParkedTask(task: Task): boolean {
    return task.prioritySignals.isReady
      && task.dependencies.every(dependency => dependency.status === 'resolved');
  }

  private isAutoResumableReadyTask(task: Task): boolean {
    return task.status === 'ready'
      && task.lastSchedulingReason === AUTO_RESUME_READY_REASON;
  }
}
