import type { MemoryEngine } from '../memory/memory-engine.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { MemoryContextService, ExecutionRecallSelection } from '../memory/memory-context-service.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { SchedulerEngine } from '../task/scheduler.js';
import type { ExecutionRuntime } from '../execution/execution-runtime.js';
import type { ExecutionProgressService, ExecutionProgressTracker } from '../execution/execution-progress-service.js';
import type { WorkspaceTargetService } from '../execution/workspace-target-service.js';
import type { VerificationAndDeliveryService } from '../delivery/verification-and-delivery-service.js';
import type { SessionPersistenceService } from './session-persistence-service.js';
import type { MemoryCaptureService } from '../memory/memory-capture-service.js';
import type { AgentClass, GuidanceProposal, Subtask, Suggestion, Task } from '../core/types.js';
import type { NotificationService } from '../notifications/types.js';
import { generateInteractionId } from '../utils/id.js';
import { formatExecutorError, isRecoverableExecutorFailure } from '../executor/error-utils.js';
import type { QueuedExecutionRequest } from './session-helpers.js';
import type { SessionPresentationService, GuidanceState } from './session-presentation-service.js';
import type { AgentClassService } from '../executor/agent-class-service.js';
import type { PlannerRuntimeService } from '../planner/planner-runtime-service.js';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import type { TaskEventRepo } from '../storage/task-event-repo.js';
import type { WorkUnitClaimService } from '../execution/work-unit-claim-service.js';
import type { AcceptanceCriterion } from '../core/execution-strategy-planner.js';

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
  agentClassService: AgentClassService;
  plannerRuntimeService: PlannerRuntimeService;
  subtaskRepo: SubtaskRepo;
  taskEventRepo: TaskEventRepo;
  workUnitClaimService: WorkUnitClaimService;
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
      this.deps.callbacks.appendTaskQueueSnapshot('task state changed');
    };

    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) {
      this.deps.callbacks.appendOutput(`Error: task not found ${taskId}`);
      return;
    }

    this.deps.callbacks.appendOutput(
      '【MetaClaw｜提取最近历史记录上下文】',
      `→ MetaClaw：正在回忆任务 #${taskId} 的上下文...`,
      '【MetaClaw｜构建执行上下文】',
      `→ MetaClaw：正在构建任务 #${taskId} 的执行上下文...`,
    );
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
    for (const resolvedPreference of executionContextBundle.memoryContext.resolvedPreferences) {
      this.deps.memoryEngine.recordUsage(resolvedPreference.id, taskId);
    }
    if (executionContextBundle.memoryContext.resolvedPreferences.length > 0) {
      this.deps.callbacks.appendOutput(
        `→ 已注入 ${executionContextBundle.memoryContext.resolvedPreferences.length} 条偏好`,
        ...executionContextBundle.memoryContext.resolvedPreferences.map(preference =>
          `  - [${preference.scope}] ${preference.content} (confidence=${preference.confidence}, 命中原因：${preference.reason})`
        ),
      );
    }
    this.deps.callbacks.appendOutput(
      `→ MetaClaw：已召回 ${conversationHistory.length} 条相关上下文`,
      '→ MetaClaw：执行上下文已准备完成',
      '【MetaClaw｜执行上下文准备完成】',
    );

    let progressTracker: ExecutionProgressTracker | null = null;
    try {
      const currentTask = this.deps.taskRuntimeService.findTask(taskId);
      if (!currentTask) {
        await finishExecution([`Error: task not found ${taskId}`]);
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

      const agentClasses = this.deps.agentClassService.listAgentClasses();
      const plannerResult = this.deps.plannerRuntimeService.plan({
        task: currentTask,
        userPrompt,
        taskExecutionPlan: this.deps.taskRuntimeService.buildExecutionPlan(currentTask, userPrompt),
        intentDecision: request.executionMode === 'fresh' ? request.intentDecision : null,
        agentClasses,
        resources: currentTask.resources,
        recalledTaskIds: approvedRecallSelection?.relatedTaskIds ?? [],
      });

      if (plannerResult.intent.action !== 'plan_work_graph') {
        await this.deps.scheduler.markDispatchFinished(taskId, {
          taskId,
          executionId,
          status: 'success',
          reason: plannerResult.intent.reason,
        });
        await finishExecution([
          `-> Planner: ${plannerResult.intent.action} (${plannerResult.intent.reason})`,
        ], { scheduleNext: false });
        progressTracker.clear();
        return;
      }

      this.deps.callbacks.appendOutput(
        `-> Planner: planned ${plannerResult.subtasks.length} subtask(s)`,
        `-> Planner: ${plannerResult.workGraph?.reason ?? 'work graph ready'}`,
      );

      const executionOutputs: string[] = [];
      let finalExecution: Awaited<ReturnType<ExecutionRuntime['run']>> | null = null;
      for (;;) {
        const readySubtask = this.findNextReadySubtask(taskId);
        if (!readySubtask) break;

        const claim = this.deps.workUnitClaimService.claim({ taskId, subtask: readySubtask });
        if (!claim) {
          await this.deps.scheduler.markDispatchBlocked(taskId, 'no idle executor work unit can claim the ready subtask');
          await finishExecution([
            `Subtask waiting for executor work unit: ${readySubtask.title}`,
            this.deps.presentation.buildRecoverableFailureHint(taskId, 'no idle executor work unit'),
          ], { scheduleNext: false });
          progressTracker.clear();
          return;
        }

        const agentClass = this.findAgentClassForClaim(agentClasses, claim.workUnit.agentClassName);
        this.deps.subtaskRepo.updateStatus(readySubtask.id, 'running');
        this.recordTaskEvent(taskId, readySubtask.id, 'subtask_claimed', readySubtask.title, {
          workUnitId: claim.workUnit.id,
          agentClassName: agentClass.name,
        });
        claim.markRunning();
        this.deps.callbacks.setRunningExecutorName(taskId, agentClass.name);
        this.deps.callbacks.refreshRuntimeState();
        this.deps.callbacks.appendOutput(
          `[Planner: dispatch] ${readySubtask.id}`,
          `-> Work Unit ${claim.workUnit.id} (${agentClass.name}) started`,
          `【Executor: ${agentClass.name}｜执行】`,
          `→ Executor: ${agentClass.name} 开始执行任务 #${taskId}`,
        );

        const execution = await this.deps.executionRuntime.run({
          taskId,
          executionId,
          spec: {
            subtask: readySubtask,
            workUnit: claim.workUnit,
            agentClass,
            acceptance: readySubtask.acceptance,
            expectedOutput: readySubtask.expectedOutput,
          },
          executorInput: {
            task: this.deps.taskRuntimeService.findTask(taskId)!,
            preferences,
            userPrompt: readySubtask.goal,
            conversationHistory,
            executionContextBundle,
          },
          onProgress: progressTracker.onProgress,
        });
        finalExecution = execution;

        if (execution.status === 'success') {
          this.deps.subtaskRepo.updateStatus(readySubtask.id, 'done', { result: execution.output });
          this.recordTaskEvent(taskId, readySubtask.id, 'subtask_done', readySubtask.title, {
          executorName: execution.executorName,
        });
          executionOutputs.push(execution.output);
          claim.release();
          continue;
        }

        const errorMessage = formatExecutorError(execution.error ?? undefined) ?? execution.error ?? 'unknown error';
        this.deps.subtaskRepo.updateStatus(readySubtask.id, 'blocked', { error: errorMessage });
        this.recordTaskEvent(taskId, readySubtask.id, 'subtask_failed', errorMessage, {
          executorName: execution.executorName,
        });
        claim.markFailed(errorMessage);
        claim.release();
        if (isRecoverableExecutorFailure(errorMessage)) {
          await this.deps.scheduler.markDispatchBlocked(taskId, errorMessage);
          await finishExecution([
            `✗ 执行失败: ${errorMessage}`,
            this.deps.presentation.buildRecoverableFailureHint(taskId, errorMessage),
          ], { scheduleNext: false });
          progressTracker.clear();
          return;
        }

        this.deps.taskRuntimeService.transitionTask(taskId, 'parked');
        await finishExecution([`✗ 执行失败: ${errorMessage}`]);
        progressTracker.clear();
        return;
      }

      if (!finalExecution) {
        await this.deps.scheduler.markDispatchFinished(taskId, {
          taskId,
          executionId,
          status: 'success',
          reason: 'planner found no executable subtasks',
        });
        await finishExecution(['-> Planner: no executable ready subtask'], { scheduleNext: false });
        progressTracker.clear();
        return;
      }

      const execution = {
        ...finalExecution,
        output: executionOutputs.length === 1
          ? executionOutputs[0]!
          : executionOutputs.map((output, index) => {
              const subtask = this.deps.subtaskRepo.listByTask(taskId)[index];
              return `## ${subtask?.title ?? `Subtask ${index + 1}`}\n\n${output}`;
            }).join('\n\n'),
        userPrompt,
      };
      this.deps.persistenceService.recordInteraction({
        taskId,
        sessionId: this.deps.sessionId,
        userInput: userPrompt,
        systemOutput: execution.output,
        executorUsed: execution.executorName,
      });

      await this.handleSuccessfulExecution({
        task,
        taskId,
        request,
        executionId,
        executionMode,
        userPrompt,
        execution,
        acceptanceCriteria: this.buildAcceptanceCriteria(taskId),
        progressTracker,
        finishExecution,
      });
    } catch (error) {
      const currentTask = this.deps.taskRuntimeService.findTask(taskId);
      if (currentTask?.status === 'running') {
        const errorMessage = formatExecutorError((error as Error).message) ?? (error as Error).message;
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
    acceptanceCriteria: AcceptanceCriterion[];
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
      const blockReason = delivery.verification.reason ?? 'final result did not satisfy verification criteria';
      await this.deps.scheduler.markDispatchBlocked(input.taskId, blockReason);
      await input.finishExecution([
        `执行未完成: ${blockReason}`,
        `✗ 验收未通过: ${blockReason}`,
        this.deps.presentation.buildVerificationFailureHint(input.taskId),
      ], { scheduleNext: false });
      input.progressTracker.clear();
      return;
    }

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
    completionLines.push(...this.deps.verificationAndDeliveryService.formatCompletion({
      output: input.execution.output,
      durationMs: input.execution.durationMs,
      workspaceContext,
      artifactPaths,
      summary: taskSummary,
      nextStep: this.buildCompletionNextStep(suggestion),
    }));
    if (input.executionMode === 'resume-blocked') {
      this.deps.verificationAndDeliveryService.appendBlockedRecoveryCompletionBlock(completionLines, {
        task: input.task,
        summary: taskSummary,
        output: input.execution.output,
        recoveryTrigger: input.request.recoveryTrigger,
      });
    }

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
      const guidance = this.deps.callbacks.setLatestGuidance('completion suggestion', suggestion);
      completionLines.push(...this.deps.presentation.formatGuidanceBlock(
        'completion suggestion',
        suggestion,
        guidance.taskTitle,
        { emptyReason: 'follow-up task is available' },
      ));
    }

    await input.finishExecution(completionLines, { scheduleNext: false });
    if (nextProposal) {
      this.deps.callbacks.queueProposal('completion suggestion', nextProposal);
    }
    input.progressTracker.clear();
  }

  private findNextReadySubtask(taskId: string): Subtask | null {
    const subtasks = this.deps.subtaskRepo.listByTask(taskId);
    const done = new Set(subtasks.filter(subtask => subtask.status === 'done').map(subtask => subtask.id));
    return subtasks.find(subtask =>
      subtask.status === 'ready' && subtask.dependsOn.every(dependencyId => done.has(dependencyId))
    ) ?? null;
  }

  private findAgentClassForClaim(agentClasses: AgentClass[], agentClassName: string): AgentClass {
    const agentClass = agentClasses.find(item => item.name === agentClassName);
    if (!agentClass) {
      throw new Error(`claimed work unit references missing agent class: ${agentClassName}`);
    }
    return agentClass;
  }

  private buildAcceptanceCriteria(taskId: string): AcceptanceCriterion[] {
    const subtasks = this.deps.subtaskRepo.listByTask(taskId);
    return subtasks.map(subtask => ({
      id: `accept_${subtask.id}`,
      description: subtask.acceptance.join('; ') || `Complete subtask ${subtask.title}`,
      requiredEvidence: subtask.expectedOutput === 'patch' ? ['test command or reason tests were not run'] : [],
      severity: 'must',
      appliesToSubtaskIds: [subtask.id],
    }));
  }

  private recordTaskEvent(
    taskId: string,
    subtaskId: string | null,
    eventType: string,
    message: string,
    payload: Record<string, unknown>,
  ): void {
    this.deps.taskEventRepo.insert({
      id: `te_${generateInteractionId()}`,
      taskId,
      subtaskId,
      eventType,
      message,
      payload,
      createdAt: new Date().toISOString(),
    });
  }

  private buildCompletionNextStep(suggestion: { recommendedAction: string } | null): string {
    return suggestion?.recommendedAction ?? 'Continue with a follow-up task if more work is needed.';
  }
}
