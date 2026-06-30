import type { DispatchContext, SchedulerEngine } from '../task/scheduler.js';
import type { RecallReviewApplicationService } from '../memory/recall-review-application-service.js';
import type { SessionExecutionCoordinator } from './session-execution-coordinator.js';
import type { SessionPresentationService } from './session-presentation-service.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { GuidanceActionType, Task } from '../core/types.js';
import type { QueuedExecutionRequest } from './session-helpers.js';
import type { ExecutionRecallSelection } from '../memory/memory-context-service.js';
import { TaskAdmissionGate } from './task-admission-gate.js';

export interface SessionTaskExecutionApplicationCallbacks {
  appendOutput(...lines: string[]): void;
  appendGuidance(
    scene: string,
    suggestion: { taskId: string; recommendedAction: string; reasons: string[] },
  ): void;
  appendTaskQueueSnapshot(trigger: string): void;
  refreshRuntimeState(): void;
  notify(): void;
}

export interface SessionTaskExecutionApplicationDeps {
  defaultExecutorName: string;
  taskRuntimeService: TaskRuntimeService;
  scheduler: SchedulerEngine<QueuedExecutionRequest>;
  recallReviewApplicationService: RecallReviewApplicationService;
  sessionExecutionCoordinator: SessionExecutionCoordinator;
  presentation: SessionPresentationService;
  callbacks: SessionTaskExecutionApplicationCallbacks;
}

export class SessionTaskExecutionApplicationService {
  private readonly approvedRecallSelections = new Map<string, ExecutionRecallSelection>();
  private readonly taskAdmissionGate = new TaskAdmissionGate();

  constructor(private readonly deps: SessionTaskExecutionApplicationDeps) {}

  async prepareTaskExecution(
    taskId: string,
    request: QueuedExecutionRequest,
    proposalType: GuidanceActionType | null = null,
  ): Promise<void> {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) {
      this.deps.callbacks.appendOutput(`错误：任务不存在 ${taskId}`);
      return;
    }

    const admission = this.taskAdmissionGate.evaluateExecution({
      taskId,
      runningTask: this.deps.taskRuntimeService.getCurrentRunningTask(),
    });
    if (!admission.allowed) {
      this.deps.callbacks.appendOutput(...admission.lines);
      this.deps.callbacks.refreshRuntimeState();
      return;
    }

    const recallApplication = await this.deps.recallReviewApplicationService.apply({
      taskId,
      userPrompt: request.userPrompt,
      taskTitle: task.title,
      proposalType,
    });
    this.approvedRecallSelections.set(taskId, recallApplication.approvedSelection);
    this.deps.callbacks.appendOutput(...recallApplication.lines);

    await this.submitScheduledTask(taskId, request);
  }

  dispatchTask(taskId: string, context?: DispatchContext<QueuedExecutionRequest>): Promise<void> {
    const dispatchPromise = (async () => {
      const request = context?.executionRequest ?? this.buildFallbackExecutionRequest(taskId, context);
      if (!request) {
        this.deps.callbacks.appendOutput(`错误：任务 #${taskId} 缺少执行请求，无法派发`);
        return;
      }

      if (context?.missingExecutionRequest ?? true) {
        this.deps.callbacks.appendOutput(`→ 任务 #${taskId} 缺少待执行上下文，已根据持久化任务信息重建执行请求`);
      }

      const mergedRequest = context
        ? {
            ...request,
            executionMode: context.executionMode ?? request.executionMode,
            schedulingReason: context.schedulingReason ?? request.schedulingReason,
          }
        : request;
      await this.executeTask(taskId, mergedRequest);
    })();

    void dispatchPromise.finally(() => {
      this.deps.callbacks.notify();
    });

    return dispatchPromise;
  }

  private async submitScheduledTask(taskId: string, request: QueuedExecutionRequest): Promise<void> {
    const result = await this.deps.scheduler.submit(taskId, {
      reason: request.schedulingReason || '新任务提交',
      executionRequest: request,
    });
    this.deps.callbacks.refreshRuntimeState();

    if (result.action === 'queued') {
      this.deps.callbacks.appendOutput(`→ 任务 #${taskId} 已进入待执行队列`);
      this.deps.callbacks.appendTaskQueueSnapshot('任务进入待执行队列');
      return;
    }

    if (result.action === 'preempted') {
      this.deps.callbacks.appendOutput(
        `→ 高优任务到达，抢占当前任务 #${result.preemptedTaskId}`,
        `→ 原因：${request.schedulingReason || '用户显式要求优先处理'}`,
        `→ 任务 #${result.preemptedTaskId} 已挂起，开始执行 #${taskId}`,
        `→ 执行准备：先由 ${this.deps.defaultExecutorName} 解析意图与构建上下文，随后按路由派发到具体 Executor`,
      );
      this.deps.callbacks.appendTaskQueueSnapshot('高优任务抢占，队列已重排');
      return;
    }

    this.deps.callbacks.appendOutput(`→ 执行准备：先由 ${this.deps.defaultExecutorName} 解析意图与构建上下文，随后按路由派发到具体 Executor`);
    this.deps.callbacks.appendTaskQueueSnapshot('任务开始执行');
  }

  private buildFallbackExecutionRequest(
    taskId: string,
    context?: DispatchContext<QueuedExecutionRequest>,
  ): QueuedExecutionRequest | null {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) {
      return null;
    }

    const inferredMode = context?.executionMode
      ?? (task.snapshots.length > 0 || task.lastInterruptionReason ? 'resume-parked' : 'fresh');

    return {
      userPrompt: task.goal,
      contextTaskId: task.id,
      executionMode: inferredMode,
      schedulingReason: context?.schedulingReason
        ?? task.lastSchedulingReason
        ?? '调度器根据持久化任务自动恢复执行',
    };
  }

  private async executeTask(taskId: string, request: QueuedExecutionRequest): Promise<void> {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) {
      this.deps.callbacks.appendOutput(`错误：任务不存在 ${taskId}`);
      return;
    }

    this.maybeAppendExecutionGuidance(task, request);

    const approvedRecallSelection = this.approvedRecallSelections.get(taskId) ?? null;
    this.approvedRecallSelections.delete(taskId);
    await this.deps.sessionExecutionCoordinator.execute({
      taskId,
      request,
      approvedRecallSelection,
    });
  }

  private maybeAppendExecutionGuidance(task: Task, request: QueuedExecutionRequest): void {
    if (request.executionMode === 'resume-blocked') {
      this.deps.callbacks.appendGuidance('解除阻塞后恢复', this.deps.presentation.formatBlockedExecutionGuidance(
        task,
        request.newlyProvidedResources,
      ));
      return;
    }

    if (request.executionMode === 'resume-parked') {
      this.deps.callbacks.appendGuidance('恢复已挂起任务', this.deps.presentation.formatResumeExecutionGuidance(task));
    }
  }
}
