import type { TaskRepo } from '../storage/task-repo.js';
import type { OrchestrationEngine } from './orchestration.js';
import type { TaskEngine } from './task-engine.js';
import { filterDurableTasks, type TaskClearScope } from './task-routing.js';
import type { Dependency, RuntimeState, Task, TaskSnapshot, TaskStatus } from './types.js';
import { planTaskExecution, type TaskExecutionPlan } from './task-execution-planner.js';

export type SchedulableTaskPriority = 'normal' | 'high' | 'urgent';

export interface SchedulableTask {
  task: Task;
  priority: SchedulableTaskPriority;
  reason: string;
  dispatchContext?: {
    executionMode?: 'fresh' | 'resume-parked' | 'resume-blocked';
    schedulingReason?: string;
  };
}

export interface TaskDispatchResult {
  taskId: string;
  executionId: string;
  status: 'success' | 'failed' | 'blocked' | 'cancelled';
  reason: string;
}

export interface SchedulerBridge {
  getNext(): Promise<SchedulableTask | null>;
  markDispatchStarted(taskId: string, executionId: string): void;
  markDispatchFinished(taskId: string, result: TaskDispatchResult): Promise<void>;
  markDispatchBlocked(taskId: string, reason: string): Promise<void>;
  waitForIdle(): Promise<void>;
}

export interface TaskRuntimeServiceDeps {
  taskEngine: TaskEngine;
  taskRepo: TaskRepo;
  orchestration: OrchestrationEngine;
}

export type TaskRuntimeCommand =
  | { type: 'create'; input: { title: string; goal: string; resources?: string[] } }
  | { type: 'find'; taskId: string }
  | { type: 'update'; taskId: string; changes: Partial<Task> }
  | { type: 'transition'; taskId: string; status: TaskStatus }
  | { type: 'cancel'; taskId: string; reason?: string }
  | { type: 'block'; taskId: string; dependency: Omit<Dependency, 'createdAt'> }
  | { type: 'unblock'; taskId: string }
  | { type: 'resume_parked'; taskId: string }
  | { type: 'attach_resource'; taskId: string; resourcePath: string }
  | { type: 'park'; taskId: string; reason: string; snapshot: Omit<TaskSnapshot, 'createdAt'> }
  | { type: 'start_dispatch'; taskId: string; reason: string }
  | { type: 'queue'; taskId: string; reason: string };

export interface TaskRuntimeResult {
  status: 'ok' | 'not_found' | 'invalid';
  task: Task | null;
  tasks?: Task[];
  reason: string;
}

export interface TaskClearResult {
  cancelled: Task[];
  runningCancelled: boolean;
}

export interface TaskFocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

const PREEMPT_DELTA = 5;
const AUTO_RESUME_READY_REASON = '挂起任务满足执行条件，恢复进入待调度队列';
const TASK_QUEUE_SNAPSHOT_LIMIT = 5;

const CLEAR_SCOPE_STATUSES: Record<TaskClearScope, TaskStatus[]> = {
  all: ['created', 'ready', 'running', 'parked', 'blocked'],
  parked: ['parked'],
  blocked: ['blocked'],
};

const CLEAR_SCOPE_LABELS: Record<TaskClearScope, string> = {
  all: '所有未完成任务',
  parked: '挂起任务',
  blocked: '阻塞任务',
};

export class TaskRuntimeService {
  private currentTaskId: string | null = null;
  private focusContext: TaskFocusContext | null = null;

  constructor(private readonly deps: TaskRuntimeServiceDeps) {}

  getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }

  setCurrentTaskId(taskId: string | null): void {
    this.currentTaskId = taskId;
  }

  getFocusContext(): TaskFocusContext | null {
    return this.focusContext ? { ...this.focusContext } : null;
  }

  setFocusContext(focus: TaskFocusContext | null): void {
    this.focusContext = focus ? { ...focus } : null;
  }

  listTasks(): Task[] {
    return this.deps.taskEngine.list();
  }

  listActiveTasks(): Task[] {
    return this.deps.taskRepo.findActive();
  }

  listTasksByStatus(status: Task['status']): Task[] {
    return this.deps.taskRepo.findByStatus(status);
  }

  findTask(taskId: string): Task | null {
    return this.deps.taskRepo.findById(taskId);
  }

  createTask(input: { title: string; goal: string; resources?: string[] }): Task {
    return this.deps.taskEngine.create(input);
  }

  buildExecutionPlan(task: Task, userPrompt: string): TaskExecutionPlan {
    return planTaskExecution(task, userPrompt);
  }

  updateTask(taskId: string, changes: Partial<Task>): Task | null {
    if (!this.findTask(taskId)) {
      return null;
    }

    this.deps.taskRepo.update(taskId, changes);
    return this.findTask(taskId);
  }

  transitionTask(taskId: string, status: TaskStatus): Task {
    return this.deps.taskEngine.transition(taskId, status);
  }

  cancelTask(taskId: string, reason?: string): Task {
    return this.deps.taskEngine.cancel(taskId, reason);
  }

  parkTask(taskId: string, reason: string, snapshot: Omit<TaskSnapshot, 'createdAt'>): Task {
    return this.deps.taskEngine.park(taskId, reason, snapshot);
  }

  blockTask(taskId: string, dependency: Omit<Dependency, 'createdAt'>): Task {
    return this.deps.taskEngine.block(taskId, dependency);
  }

  unblockTask(taskId: string): Task {
    return this.deps.taskEngine.unblock(taskId);
  }

  resumeParkedTask(taskId: string): Task {
    return this.deps.taskEngine.resume(taskId).task;
  }

  clearTasks(scope: TaskClearScope, reason = `用户清空${CLEAR_SCOPE_LABELS[scope]}`): TaskClearResult {
    const statuses = CLEAR_SCOPE_STATUSES[scope];
    const candidates = filterDurableTasks(this.listTasks())
      .filter(task => statuses.includes(task.status));
    const runningCancelled = candidates.some(task => task.status === 'running');

    for (const task of candidates) {
      this.deps.taskEngine.cancel(task.id, reason);
    }

    return {
      cancelled: candidates,
      runningCancelled,
    };
  }

  attachResource(taskId: string, resourcePath: string): Task {
    return this.deps.taskEngine.attachResource(taskId, resourcePath);
  }

  getCurrentRunningTask(): Task | null {
    return this.listTasksByStatus('running')[0] ?? null;
  }

  execute(command: TaskRuntimeCommand): TaskRuntimeResult {
    try {
      switch (command.type) {
        case 'create': {
          const task = this.createTask(command.input);
          return { status: 'ok', task, reason: 'created' };
        }
        case 'find': {
          const task = this.findTask(command.taskId);
          return {
            status: task ? 'ok' : 'not_found',
            task,
            reason: task ? 'found' : `任务不存在: ${command.taskId}`,
          };
        }
        case 'update': {
          const task = this.updateTask(command.taskId, command.changes);
          return {
            status: task ? 'ok' : 'not_found',
            task,
            reason: task ? 'updated' : `任务不存在: ${command.taskId}`,
          };
        }
        case 'transition':
          return { status: 'ok', task: this.transitionTask(command.taskId, command.status), reason: 'transitioned' };
        case 'cancel':
          return { status: 'ok', task: this.cancelTask(command.taskId, command.reason), reason: 'cancelled' };
        case 'block':
          return { status: 'ok', task: this.blockTask(command.taskId, command.dependency), reason: 'blocked' };
        case 'unblock':
          return { status: 'ok', task: this.unblockTask(command.taskId), reason: 'unblocked' };
        case 'resume_parked':
          return { status: 'ok', task: this.resumeParkedTask(command.taskId), reason: 'parked_resumed' };
        case 'attach_resource':
          return { status: 'ok', task: this.attachResource(command.taskId, command.resourcePath), reason: 'resource_attached' };
        case 'park':
          return { status: 'ok', task: this.parkTask(command.taskId, command.reason, command.snapshot), reason: 'parked' };
        case 'start_dispatch':
          return { status: 'ok', task: this.startDispatch(command.taskId, command.reason), reason: 'dispatch_started' };
        case 'queue':
          return { status: 'ok', task: this.queueTask(command.taskId, command.reason), reason: 'queued' };
      }
    } catch (error) {
      return {
        status: (error as Error).message.includes('任务不存在') ? 'not_found' : 'invalid',
        task: null,
        reason: (error as Error).message,
      };
    }
  }

  getRuntimeState(lastEvent: string | null): RuntimeState {
    const tasks = this.listTasks();
    return {
      runningTaskId: this.getCurrentRunningTask()?.id ?? null,
      runningExecutorName: null,
      readyTaskIds: tasks.filter(task => task.status === 'ready').map(task => task.id),
      blockedTaskIds: tasks.filter(task => task.status === 'blocked').map(task => task.id),
      parkedTaskIds: tasks.filter(task => task.status === 'parked').map(task => task.id),
      lastEvent,
    };
  }

  normalizeTaskForScheduling(taskId: string): Task {
    const task = this.requireTask(taskId);
    if (task.status === 'created') {
      return this.deps.taskEngine.transition(task.id, 'ready');
    }

    if (task.status === 'parked') {
      return this.resumeParkedTask(task.id);
    }

    return task;
  }

  startDispatch(taskId: string, reason: string): Task {
    const task = this.requireTask(taskId);
    if (task.status === 'created') {
      this.deps.taskEngine.transition(taskId, 'ready');
    }

    const refreshed = this.requireTask(taskId);
    if (refreshed.status === 'parked') {
      this.resumeParkedTask(taskId);
    }

    const runnable = this.requireTask(taskId);
    if (runnable.status === 'ready') {
      this.deps.taskEngine.transition(taskId, 'running');
    }

    this.updateTask(taskId, { lastSchedulingReason: reason });
    return this.requireTask(taskId);
  }

  queueTask(taskId: string, reason: string): Task {
    const task = this.requireTask(taskId);
    this.updateTask(taskId, { lastSchedulingReason: reason });
    return task;
  }

  shouldPreempt(currentTask: Task, candidateTask: Task): boolean {
    const currentScore = this.deps.orchestration.evaluateTask(currentTask).score.total;
    const candidateScore = this.deps.orchestration.evaluateTask(candidateTask).score.total;
    const hasExplicitSemanticPriority = candidateTask.prioritySignals.semanticPriority === 'urgent';

    return hasExplicitSemanticPriority || candidateScore >= currentScore + PREEMPT_DELTA;
  }

  preemptCurrentTask(reason: string): Task | null {
    const currentTask = this.getCurrentRunningTask();
    if (!currentTask) {
      return null;
    }

    const interruptionReason = `被更高优先级任务抢占：${reason}`;
    this.deps.taskEngine.park(currentTask.id, interruptionReason, {
      done: currentTask.summary ? [currentTask.summary] : [],
      pending: [currentTask.goal],
      nextStep: '恢复后继续当前未完成步骤',
      pauseReason: interruptionReason,
    });
    this.updateTask(currentTask.id, {
      lastInterruptionReason: interruptionReason,
      interruptionCount: currentTask.interruptionCount + 1,
    });
    return this.requireTask(currentTask.id);
  }

  async promoteAutoResumableParkedTasks(
    classifyPrioritySignals?: (tasks: Task[]) => Promise<void> | void,
  ): Promise<Task[]> {
    const candidates = this.listTasksByStatus('parked')
      .filter(task => this.isAutoResumableParkedTask(task));

    if (classifyPrioritySignals) {
      await Promise.resolve(classifyPrioritySignals(candidates));
    }

    const promoted: Task[] = [];
    for (const task of candidates) {
      const refreshed = this.findTask(task.id);
      if (!refreshed || refreshed.status !== 'parked') {
        continue;
      }

      this.resumeParkedTask(task.id);
      this.updateTask(task.id, {
        lastSchedulingReason: AUTO_RESUME_READY_REASON,
      });
      promoted.push(this.requireTask(task.id));
    }

    return promoted;
  }

  getNextSchedulableTask(): SchedulableTask | null {
    const prioritized = this.deps.orchestration.getPrioritizedTasks();
    if (prioritized.length === 0) return null;

    const task = prioritized[0].task;
    const schedulingReason = this.isAutoResumableReadyTask(task)
      ? task.lastSchedulingReason || AUTO_RESUME_READY_REASON
      : prioritized[0].reasons[0] || '最高优先级任务';

    return {
      task,
      priority: this.resolveSchedulablePriority(task),
      reason: schedulingReason,
      dispatchContext: this.isAutoResumableReadyTask(task)
        ? {
            executionMode: 'resume-parked',
            schedulingReason,
          }
        : undefined,
    };
  }

  private requireTask(taskId: string): Task {
    const task = this.findTask(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    return task;
  }

  private isAutoResumableParkedTask(task: Task): boolean {
    return task.prioritySignals.isReady
      && task.dependencies.every(dependency => dependency.status === 'resolved')
      && this.hasAutoResumablePauseReason(task);
  }

  private isAutoResumableReadyTask(task: Task): boolean {
    return task.status === 'ready'
      && task.lastSchedulingReason === AUTO_RESUME_READY_REASON;
  }

  private hasAutoResumablePauseReason(task: Task): boolean {
    const latestSnapshot = task.snapshots[task.snapshots.length - 1];
    const pauseReason = latestSnapshot?.pauseReason || task.lastInterruptionReason || '';
    if (!pauseReason) {
      return false;
    }

    return !/执行失败|执行异常|验收未通过|执行未完成|failed|exception/i.test(pauseReason);
  }

  private resolveSchedulablePriority(task: Task): SchedulableTaskPriority {
    if (task.prioritySignals.semanticPriority) {
      return task.prioritySignals.semanticPriority;
    }
    if (task.prioritySignals.dueAt || task.prioritySignals.blocksOthers) {
      return 'high';
    }
    return 'normal';
  }
}
