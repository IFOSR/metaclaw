import type { MemoryEngine } from '../core/memory-engine.js';
import type { OrchestrationEngine } from '../core/orchestration.js';
import type { MemoryContextService, ExecutionRecallSelection } from '../core/memory-context-service.js';
import type { TaskRuntimeService } from '../core/task-runtime-service.js';
import type { SchedulerEngine } from '../core/scheduler.js';
import type { ExecutorRoutingCoordinator } from '../core/executor-routing-coordinator.js';
import type { ExecutionRuntime } from '../core/execution-runtime.js';
import type { ExecutionProgressService, ExecutionProgressTracker } from '../core/execution-progress-service.js';
import type { WorkspaceTargetService } from '../core/workspace-target-service.js';
import type { VerificationAndDeliveryService } from '../core/verification-and-delivery-service.js';
import type { SessionPersistenceService } from '../core/session-persistence-service.js';
import type { MemoryCaptureService } from '../core/memory-capture-service.js';
import type { GuidanceProposal, Suggestion, Task } from '../core/types.js';
import type { NotificationService } from '../notifications/types.js';
import { generateInteractionId } from '../utils/id.js';
import { isRecoverableExecutorFailure } from '../executor/error-utils.js';
import type { QueuedExecutionRequest } from './session-helpers.js';
import type { SessionPresentationService, GuidanceState } from './session-presentation-service.js';

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

export interface SessionExecutionCoordinatorInput {
  taskId: string;
  request: QueuedExecutionRequest;
  approvedRecallSelection: ExecutionRecallSelection | null;
}

export interface SessionExecutionCoordinatorDeps {
  sessionId: string;
  memoryEngine: MemoryEngine;
  orchestration: OrchestrationEngine;
  notifier: NotificationService;
  taskRuntimeService: TaskRuntimeService;
  memoryContextService: MemoryContextService;
  executorRoutingCoordinator: ExecutorRoutingCoordinator;
  executionRuntime: ExecutionRuntime;
  scheduler: SchedulerEngine<QueuedExecutionRequest>;
  executionProgressService: ExecutionProgressService;
  workspaceTargetService: WorkspaceTargetService;
  verificationAndDeliveryService: VerificationAndDeliveryService;
  persistenceService: SessionPersistenceService;
  memoryCaptureService: MemoryCaptureService;
  presentation: SessionPresentationService;
  callbacks: {
    appendOutput(...lines: string[]): void;
    refreshRuntimeState(): void;
    appendTaskQueueSnapshot(trigger: string): void;
    setFocusContext(focus: FocusContext | null): void;
    setRunningExecutorName(taskId: string, name: string): void;
    clearRunningExecutorName(taskId: string): void;
    persistSessionState(changes: {
      lastFocusedTaskId?: string | null;
      lastCompletedTaskId?: string | null;
      lastSessionId?: string | null;
    }): void;
    setLatestGuidance(scene: string, suggestion: Suggestion): GuidanceState;
    queueProposal(scene: string, proposal: GuidanceProposal): void;
  };
}

export class SessionExecutionCoordinator {
  constructor(private readonly deps: SessionExecutionCoordinatorDeps) {}

  async execute(input: SessionExecutionCoordinatorInput): Promise<void> {
    const { taskId, request, approvedRecallSelection } = input;
    const { userPrompt, contextTaskId, executionMode, schedulingReason, newlyProvidedResources } = request;
    const finishExecution = async (lines: string[], options: { scheduleNext?: boolean } = {}) => {
      this.deps.callbacks.clearRunningExecutorName(taskId);
      this.deps.callbacks.refreshRuntimeState();
      this.deps.callbacks.appendOutput(...lines);
      if (options.scheduleNext ?? true) {
        await this.deps.scheduler.scheduleNext();
      }
      this.deps.callbacks.refreshRuntimeState();
      this.deps.callbacks.appendTaskQueueSnapshot('任务状态变更');
    };

    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) {
      this.deps.callbacks.appendOutput(`错误：任务不存在 ${taskId}`);
      return;
    }

    this.deps.callbacks.appendOutput(
      '【MetaClaw｜提取最近历史记录上下文】',
      `→ MetaClaw：正在回忆任务 #${taskId} 的上下文...`,
    );
    this.deps.callbacks.appendOutput('【MetaClaw｜构建执行上下文】');
    const memoryContext = await this.deps.memoryContextService.prepareExecutionContext({
      taskId,
      sessionId: this.deps.sessionId,
      userPrompt,
      contextTaskId,
      executionMode,
      schedulingReason,
      newlyProvidedResources,
      approvedRecallSelection,
      includeRecentConversationContext: request.includeRecentConversationContext,
    });
    const { preferences, conversationHistory, executionContextBundle } = memoryContext;
    this.deps.callbacks.appendOutput(
      `→ MetaClaw：已召回 ${conversationHistory.length} 条相关上下文`,
      `→ MetaClaw：正在构建任务 #${taskId} 的执行上下文...`,
      '→ MetaClaw：执行上下文已准备完成',
      '【MetaClaw｜执行上下文准备完成】',
    );
    if (executionContextBundle.memoryContext.resolvedPreferences.length > 0) {
      for (const resolvedPreference of executionContextBundle.memoryContext.resolvedPreferences) {
        this.deps.memoryEngine.recordUsage(resolvedPreference.id, taskId);
      }
      this.deps.callbacks.appendOutput(
        `→ 已注入 ${executionContextBundle.memoryContext.resolvedPreferences.length} 条偏好`,
        ...executionContextBundle.memoryContext.resolvedPreferences.map(preference =>
          `  - [${preference.scope}] ${preference.content} (confidence=${preference.confidence}, 命中原因：${preference.reason})`
        ),
      );
    }

    this.deps.callbacks.refreshRuntimeState();
    const routedExecutor = this.deps.executorRoutingCoordinator.resolveForTask({
      taskId,
      userInput: userPrompt,
      intentDecision: request.intentDecision,
      semanticDecision: request.semanticExecutorDecision,
    });
    this.deps.callbacks.setRunningExecutorName(
      taskId,
      this.deps.executorRoutingCoordinator.formatRunLabel(routedExecutor.executionPlan),
    );
    this.deps.callbacks.appendOutput(...this.deps.executorRoutingCoordinator.formatRoutingDecision(routedExecutor));
    if (routedExecutor.executionPlan.mode === 'race_executors') {
      this.deps.callbacks.appendOutput(this.deps.executorRoutingCoordinator.formatRaceDispatchLine(routedExecutor.executionPlan));
    }

    this.deps.callbacks.refreshRuntimeState();
    this.deps.callbacks.appendOutput(
      `【Executor: ${routedExecutor.executionPlan.selectedExecutor}｜执行】`,
      `→ Executor: ${routedExecutor.executionPlan.selectedExecutor} 开始执行任务 #${taskId}`,
    );

    let progressTracker: ExecutionProgressTracker | null = null;
    try {
      const currentTask = this.deps.taskRuntimeService.findTask(taskId);
      if (!currentTask) {
        await finishExecution([`错误：任务不存在 ${taskId}`]);
        return;
      }

      if (currentTask.status !== 'running') {
        this.deps.callbacks.clearRunningExecutorName(taskId);
        this.deps.callbacks.refreshRuntimeState();
        return;
      }

      this.deps.workspaceTargetService.ensureTargets(executionContextBundle.workspaceContext?.targetPaths ?? []);

      const executionId = `exec_${generateInteractionId()}`;
      this.deps.scheduler.markDispatchStarted(taskId, executionId);
      progressTracker = this.deps.executionProgressService.createTracker({
        taskId,
        executionId,
        appendOutput: line => this.deps.callbacks.appendOutput(line),
      });

      const executorInput = {
        task: this.deps.taskRuntimeService.findTask(taskId)!,
        preferences,
        userPrompt,
        conversationHistory,
        executionContextBundle,
      };

      const execution = await this.deps.executionRuntime.run({
        taskId,
        executionId,
        plan: routedExecutor.executionPlan,
        executorInput,
        onProgress: progressTracker.onProgress,
      });
      if (execution.runtime.abortedExecutors.length > 0) {
        this.deps.callbacks.appendOutput(`→ ${execution.executorName} 已先返回，已终止：${execution.runtime.abortedExecutors.join('、')}`);
      }
      if (execution.runtime.fallbackLines.length > 0) {
        this.deps.callbacks.appendOutput(...execution.runtime.fallbackLines.map(line => `→ ${line}`));
      }

      const latestTask = this.deps.taskRuntimeService.findTask(taskId);
      if (!latestTask || latestTask.status !== 'running') {
        this.deps.callbacks.clearRunningExecutorName(taskId);
        this.deps.callbacks.refreshRuntimeState();
        return;
      }

      const taskAfterFallback = this.deps.taskRuntimeService.findTask(taskId);
      if (!taskAfterFallback || taskAfterFallback.status !== 'running') {
        this.deps.callbacks.clearRunningExecutorName(taskId);
        this.deps.callbacks.refreshRuntimeState();
        return;
      }

      this.deps.persistenceService.recordInteraction({
        taskId,
        sessionId: this.deps.sessionId,
        userInput: userPrompt,
        systemOutput: execution.output,
        executorUsed: execution.executorName,
      });

      if (execution.status === 'success') {
        await this.handleSuccessfulExecution({
          task,
          taskId,
          request,
          executionId,
          executionMode,
          userPrompt,
          execution,
          routedEventId: routedExecutor.eventId,
          routedSelectedExecutor: routedExecutor.decision.selectedExecutor,
          acceptanceCriteria: routedExecutor.executionPlan.acceptanceCriteria,
          progressTracker,
          finishExecution,
        });
        return;
      }

      const errorMessage = execution.error || '未知错误';
      this.deps.persistenceService.markRouteEventResult(routedExecutor.eventId, `failed:${errorMessage}`);
      if (isRecoverableExecutorFailure(errorMessage)) {
        await this.deps.scheduler.markDispatchBlocked(taskId, errorMessage);
        await finishExecution([
          `✗ 执行失败: ${errorMessage}`,
          this.deps.presentation.buildRecoverableFailureHint(taskId, errorMessage),
        ], { scheduleNext: false });
        progressTracker?.clear();
        return;
      }

      this.deps.taskRuntimeService.transitionTask(taskId, 'parked');
      await finishExecution([`✗ 执行失败: ${errorMessage}`]);
      progressTracker?.clear();
    } catch (error) {
      this.deps.persistenceService.markRouteEventResult(routedExecutor.eventId, `exception:${(error as Error).message}`);
      const currentTask = this.deps.taskRuntimeService.findTask(taskId);
      if (currentTask?.status === 'running') {
        const errorMessage = (error as Error).message;
        if (isRecoverableExecutorFailure(errorMessage)) {
          await this.deps.scheduler.markDispatchBlocked(taskId, errorMessage);
          await finishExecution([
            `✗ 执行异常: ${errorMessage}`,
            this.deps.presentation.buildRecoverableFailureHint(taskId, errorMessage),
          ], { scheduleNext: false });
          progressTracker?.clear();
          return;
        }

        this.deps.taskRuntimeService.transitionTask(taskId, 'parked');
        await finishExecution([`✗ 执行异常: ${errorMessage}`]);
        progressTracker?.clear();
        return;
      }

      progressTracker?.clear();
      this.deps.callbacks.clearRunningExecutorName(taskId);
      this.deps.callbacks.refreshRuntimeState();
    }
  }

  private async handleSuccessfulExecution(input: {
    task: Task;
    taskId: string;
    request: QueuedExecutionRequest;
    executionId: string;
    executionMode: QueuedExecutionRequest['executionMode'];
    userPrompt: string;
    execution: Awaited<ReturnType<ExecutionRuntime['run']>>;
    routedEventId: string;
    routedSelectedExecutor: string;
    acceptanceCriteria: Parameters<VerificationAndDeliveryService['prepareAsync']>[0]['acceptanceCriteria'];
    progressTracker: ExecutionProgressTracker;
    finishExecution(lines: string[], options?: { scheduleNext?: boolean }): Promise<void>;
  }): Promise<void> {
    const workspaceContext = input.execution.context.workspaceContext;
    const delivery = await this.deps.verificationAndDeliveryService.prepareAsync({
      output: input.execution.output,
      durationMs: input.execution.durationMs,
      userPrompt: input.userPrompt,
      workspaceContext,
      preferences: input.execution.context.memoryContext.resolvedPreferences,
      nextStep: '',
      acceptanceCriteria: input.acceptanceCriteria,
      evidenceText: input.progressTracker.evidenceText,
    });

    if (delivery.verification.status === 'blocked') {
      const blockReason = delivery.verification.reason ?? '最终结果未满足验收标准';
      await this.deps.scheduler.markDispatchBlocked(input.taskId, blockReason);
      this.deps.persistenceService.markRouteEventResult(input.routedEventId, 'blocked:verification_failed');
      const blockedLabel = delivery.verification.reason === '执行器返回未完成说明，未生成最终产物'
        ? '执行未完成'
        : '验收未通过';
      await input.finishExecution([
        `✗ ${blockedLabel}: ${blockReason}`,
        this.deps.presentation.buildVerificationFailureHint(input.taskId),
      ], { scheduleNext: false });
      input.progressTracker.clear();
      return;
    }

    this.deps.persistenceService.markRouteEventResult(
      input.routedEventId,
      input.execution.executorName === 'codex-cli' && input.routedSelectedExecutor !== 'codex-cli'
        ? 'fallback_codex_success'
        : 'success',
    );
    const artifactPaths = delivery.artifactPaths;
    const taskSummary = delivery.summary;
    this.deps.taskRuntimeService.updateTask(input.taskId, {
      summary: taskSummary,
      injectedPreferences: input.execution.context.memoryContext.resolvedPreferences.map(preference => preference.id),
      artifacts: artifactPaths,
    });
    this.deps.callbacks.setFocusContext({ kind: 'task', taskId: input.taskId });

    const completionLines = this.deps.memoryCaptureService.captureCompletionPatterns({
      userPrompt: input.userPrompt,
      output: input.execution.output,
      taskId: input.taskId,
    }).lines;

    const suggestion = this.deps.orchestration.suggestNext(input.taskId);
    const nextProposal = this.deps.orchestration.suggestNextProposal(input.taskId);
    await this.deps.scheduler.markDispatchFinished(input.taskId, {
      taskId: input.taskId,
      executionId: input.executionId,
      status: 'success',
      reason: taskSummary,
    });
    this.deps.callbacks.persistSessionState({
      lastFocusedTaskId: input.taskId,
      lastCompletedTaskId: input.taskId,
    });
    const completionOutputLines = this.deps.verificationAndDeliveryService.formatCompletion({
      output: input.execution.output,
      durationMs: input.execution.durationMs,
      workspaceContext,
      artifactPaths,
      summary: taskSummary,
      nextStep: this.buildCompletionNextStep(suggestion),
    });
    if (input.executionMode === 'resume-blocked') {
      this.deps.verificationAndDeliveryService.appendBlockedRecoveryCompletionBlock(completionLines, {
        task: input.task,
        summary: taskSummary,
        output: input.execution.output,
        recoveryTrigger: input.request.recoveryTrigger,
      });
    }
    completionLines.push(...completionOutputLines);

    void this.deps.verificationAndDeliveryService.deliverTaskCompletion(this.deps.notifier, {
      taskId: input.taskId,
      title: input.task.title,
      summary: taskSummary,
      output: input.execution.output,
      artifactPaths,
      durationMs: input.execution.durationMs,
      executionMode: input.executionMode,
      origin: input.request.origin ?? 'user',
      recoveryTrigger: input.request.recoveryTrigger,
    }).then(message => {
      if (message) {
        this.deps.callbacks.appendOutput(message);
      }
    });

    if (suggestion) {
      const guidance = this.deps.callbacks.setLatestGuidance('完成后建议', suggestion);
      completionLines.push(...this.deps.presentation.formatGuidanceBlock(
        '完成后建议',
        suggestion,
        guidance.taskTitle,
        { emptyReason: '已有后续任务可立即继续' },
      ));
    }

    await input.finishExecution(completionLines, { scheduleNext: false });
    if (nextProposal) {
      this.deps.callbacks.queueProposal('完成后建议', nextProposal);
    }
    input.progressTracker.clear();
  }

  private buildCompletionNextStep(suggestion: { recommendedAction: string } | null): string {
    return suggestion?.recommendedAction ?? '如需延续，可基于当前结果继续创建 follow-up 任务';
  }
}
