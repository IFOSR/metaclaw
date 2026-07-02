import type { ExecutorAdapter } from '../executor/adapter.js';
import type { RuntimeState, Task } from '../core/types.js';
import type { TaskEngine } from './task-engine.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import { TaskRuntimeService, type SchedulableTask, type TaskDispatchResult } from './task-runtime-service.js';

export interface SubmitResult {
  action: 'started' | 'queued' | 'preempted';
  taskId: string;
  preemptedTaskId?: string;
}

export interface SubmitOptions {
  reason: string;
  executionRequest?: unknown;
}

export interface DispatchContext<TExecutionRequest = unknown> {
  executionMode?: 'fresh' | 'resume-parked' | 'resume-blocked';
  schedulingReason?: string;
  executionRequest?: TExecutionRequest;
  missingExecutionRequest?: boolean;
}

export class SchedulerEngine<TExecutionRequest = unknown> {
  private lastEvent: string | null = null;
  private activeDispatches = new Set<Promise<void>>();
  private queuedExecution = new Map<string, TExecutionRequest>();
  private activeDispatchIds = new Map<string, string>();

  constructor(
    private taskEngine: TaskEngine,
    private orchestration: OrchestrationEngine,
    private executor: ExecutorAdapter,
    private onDispatch?: (taskId: string, context?: DispatchContext<TExecutionRequest>) => Promise<void> | void,
    private classifyPrioritySignals?: (tasks: Task[]) => Promise<void> | void,
    private taskRuntimeService = new TaskRuntimeService({
      taskEngine,
      taskRepo: taskEngine.getTaskRepo(),
      orchestration,
    }),
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

  async getNext(): Promise<SchedulableTask | null> {
    await this.promoteAutoResumableParkedTasks();
    return this.taskRuntimeService.getNextSchedulableTask();
  }

  markDispatchStarted(taskId: string, executionId: string): void {
    this.activeDispatchIds.set(taskId, executionId);
  }

  clearDispatch(taskId: string, reason: string): void {
    this.activeDispatchIds.delete(taskId);
    this.queuedExecution.delete(taskId);
    this.lastEvent = `task #${taskId} dispatch cleared: ${reason}`;
  }

  async markDispatchFinished(taskId: string, result: TaskDispatchResult): Promise<void> {
    this.activeDispatchIds.delete(taskId);
    this.queuedExecution.delete(taskId);

    const task = this.taskRuntimeService.findTask(taskId);
    if (task?.status === 'running') {
      this.taskRuntimeService.transitionTask(taskId, result.status === 'cancelled' ? 'cancelled' : 'done');
    }
    this.lastEvent = `任务 #${taskId} 执行结束：${result.reason}`;
    await this.scheduleNext();
  }

  async markDispatchBlocked(taskId: string, reason: string): Promise<void> {
    this.activeDispatchIds.delete(taskId);
    this.queuedExecution.delete(taskId);

    const task = this.taskRuntimeService.findTask(taskId);
    if (task?.status === 'running') {
      this.taskRuntimeService.blockTask(taskId, {
        taskId,
        type: 'manual',
        description: reason,
        status: 'waiting',
      });
    }
    this.lastEvent = `任务 #${taskId} 已阻塞：${reason}`;
    await this.scheduleNext();
  }

  async waitForIdle(): Promise<void> {
    while (this.activeDispatches.size > 0) {
      await Promise.allSettled(Array.from(this.activeDispatches));
    }
  }

  async submit(taskId: string, input: string | (SubmitOptions & { executionRequest?: TExecutionRequest })): Promise<SubmitResult> {
    const submitOptions = typeof input === 'string' ? { reason: input } : input;
    const { reason } = submitOptions;
    if ('executionRequest' in submitOptions && submitOptions.executionRequest !== undefined) {
      this.queuedExecution.set(taskId, submitOptions.executionRequest);
    }
    const task = this.taskRuntimeService.findTask(taskId);
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`);
    }

    this.taskRuntimeService.normalizeTaskForScheduling(task.id);

    const currentTask = this.getCurrentRunningTask();
    if (!currentTask) {
      await this.startTask(taskId, reason, this.buildDispatchContext(taskId));
      return { action: 'started', taskId };
    }

    const candidateTask = this.taskRuntimeService.findTask(taskId)!;
    if (candidateTask.status !== 'ready') {
      this.taskRuntimeService.queueTask(taskId, reason);
      this.lastEvent = `任务 #${taskId} 当前状态为 ${candidateTask.status}，未进入候选队列`;
      return { action: 'queued', taskId };
    }

    if (this.shouldPreempt(currentTask, candidateTask)) {
      await this.preemptWith(taskId, reason);
      return { action: 'preempted', taskId, preemptedTaskId: currentTask.id };
    }

    this.taskRuntimeService.queueTask(taskId, reason);
    this.lastEvent = `任务 #${taskId} 已进入候选队列`;
    return { action: 'queued', taskId };
  }

  async preemptWith(taskId: string, reason: string): Promise<void> {
    const currentTask = this.getCurrentRunningTask();

    if (currentTask) {
      this.taskRuntimeService.preemptCurrentTask(reason);
      this.executor.abort();
    }

    await this.startTask(taskId, reason, this.buildDispatchContext(taskId));
  }

  getRuntimeState(): RuntimeState {
    return this.taskRuntimeService.getRuntimeState(this.lastEvent);
  }

  private async startTask(taskId: string, reason: string, dispatchContext?: DispatchContext<TExecutionRequest>): Promise<void> {
    this.taskRuntimeService.startDispatch(taskId, reason);
    this.lastEvent = `开始执行任务 #${taskId}`;

    if (this.onDispatch) {
      const dispatchPromise = Promise.resolve(this.onDispatch(taskId, dispatchContext));
      this.activeDispatches.add(dispatchPromise);
      void dispatchPromise.finally(() => {
        this.activeDispatches.delete(dispatchPromise);
      });
    }
  }

  private getCurrentRunningTask(): Task | null {
    return this.taskRuntimeService.getCurrentRunningTask();
  }

  private shouldPreempt(
    currentTask: Task,
    candidateTask: Task,
  ): boolean {
    return this.taskRuntimeService.shouldPreempt(currentTask, candidateTask);
  }

  private getNextSchedulableTask():
    | { task: Task; reason: string; dispatchContext?: DispatchContext<TExecutionRequest> }
    | null {
    const next = this.taskRuntimeService.getNextSchedulableTask();
    if (!next) {
      return null;
    }

    return {
      ...next,
      dispatchContext: {
        ...this.buildDispatchContext(next.task.id),
        ...next.dispatchContext,
      },
    };
  }

  private buildDispatchContext(taskId: string): DispatchContext<TExecutionRequest> {
    const executionRequest = this.queuedExecution.get(taskId);
    if (executionRequest !== undefined) {
      return {
        executionRequest,
        missingExecutionRequest: false,
      };
    }

    return { missingExecutionRequest: true };
  }

  private async promoteAutoResumableParkedTasks(): Promise<void> {
    const promoted = await this.taskRuntimeService.promoteAutoResumableParkedTasks(this.classifyPrioritySignals);
    for (const task of promoted) {
      this.lastEvent = `任务 #${task.id} 已从挂起恢复到待调度队列`;
    }
  }
}
