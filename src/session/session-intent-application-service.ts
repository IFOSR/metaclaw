import type { OrchestrationEngine } from '../core/orchestration.js';
import type { IntentDecisionV2 } from '../core/intent-orchestrator.js';
import type { TaskSummary } from '../core/llm-bridge.js';
import type { MemoryContextService } from '../core/memory-context-service.js';
import type { TaskResumePlanner, ResumePlanResult } from '../core/task-resume-planner.js';
import type { TaskRuntimeService } from '../core/task-runtime-service.js';
import type { TaskSemanticService } from '../core/task-semantic-service.js';
import type { Task, TaskRecoveryTrigger } from '../core/types.js';
import { filterDurableTasks, type TaskClearScope, type TaskStatusQueryScope } from '../core/task-routing.js';
import type { ExecutorAdapter } from '../executor/adapter.js';
import { buildSchedulingReason, parsePriorityHint, type QueuedExecutionRequest } from './session-helpers.js';
import type { SessionPresentationService } from './session-presentation-service.js';

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

export interface SessionIntentApplicationCallbacks {
  appendOutput(...lines: string[]): void;
  appendIntentClarification(userInput: string, decision: IntentDecisionV2): void;
  runConversationInput(userInput: string): Promise<void>;
  prepareTaskExecution(taskId: string, request: QueuedExecutionRequest): Promise<void>;
  refreshRuntimeState(): void;
  setCurrentTaskId(taskId: string | null): void;
  getCurrentTaskId(): string | null;
  setFocusContext(focus: FocusContext | null): void;
  buildRecentTaskSummaries(tasks: Task[]): TaskSummary[];
  buildRecoveryTrigger(
    task: Task,
    input: {
      kind: TaskRecoveryTrigger['kind'];
      triggerReason: string;
      sourceInput?: string;
      blockedReason?: string;
      newlyProvidedResources?: string[];
    },
  ): TaskRecoveryTrigger;
}

export interface SessionIntentApplicationDeps {
  taskRuntimeService: TaskRuntimeService;
  taskSemanticService: TaskSemanticService;
  taskResumePlanner: TaskResumePlanner;
  memoryContextService: MemoryContextService;
  orchestration: OrchestrationEngine;
  executor: ExecutorAdapter;
  presentation: SessionPresentationService;
  callbacks: SessionIntentApplicationCallbacks;
}

export class SessionIntentApplicationService {
  constructor(private readonly deps: SessionIntentApplicationDeps) {}

  async apply(input: {
    userInput: string;
    decision: IntentDecisionV2;
    recentTasks: TaskSummary[];
  }): Promise<boolean> {
    const { userInput, decision, recentTasks } = input;
    this.deps.callbacks.appendOutput(...this.formatIntentDecisionProgress(decision));

    if (decision.interactionType === 'clarification') {
      this.deps.callbacks.appendIntentClarification(userInput, decision);
      return true;
    }

    if (decision.interactionType === 'direct_reply') {
      if (decision.reason === '延续当前对话，不恢复旧任务') {
        this.deps.callbacks.appendOutput(`→ ${decision.reason}`);
      }
      await this.deps.callbacks.runConversationInput(userInput);
      return true;
    }

    if (decision.interactionType === 'task_control') {
      return this.applyTaskControlDecision(userInput, decision, recentTasks);
    }

    if (decision.task.binding === 'reference' && decision.task.taskId) {
      const referencedTask = this.deps.taskRuntimeService.findTask(decision.task.taskId);
      if (!referencedTask) {
        this.deps.callbacks.appendOutput(`错误：任务不存在 ${decision.task.taskId}`);
        return true;
      }

      await this.handleReferencedTaskFromIntent(userInput, referencedTask, decision);
      return true;
    }

    await this.createAndPrepareTask(userInput, decision);
    return true;
  }

  private formatIntentDecisionProgress(decision: IntentDecisionV2): string[] {
    if (decision.interactionType === 'durable_task' || decision.interactionType === 'executor_dispatch') {
      const selectedExecutor = decision.execution.selectedExecutor ?? this.deps.executor.name;
      const strategy = decision.task.binding === 'reference'
        ? `复用已有任务并派发给 ${selectedExecutor}`
        : `创建可追踪任务并派发给 ${selectedExecutor}`;
      return [
        '→ MetaClaw：已识别可执行任务',
        `→ MetaClaw：执行策略：${strategy}`,
        `【Executor: ${selectedExecutor}｜派发准备】`,
        `→ Executor: ${selectedExecutor} 将处理该任务`,
      ];
    }

    if (decision.interactionType === 'task_control') {
      return [
        '→ MetaClaw：已识别任务控制请求',
        `→ MetaClaw：执行策略：由 MetaClaw 处理 ${decision.task.control}`,
      ];
    }

    if (decision.interactionType === 'direct_reply') {
      const selectedExecutor = decision.execution.selectedExecutor ?? this.deps.executor.name;
      return [
        '→ MetaClaw：已识别普通对话',
        '→ MetaClaw：执行策略：直接回答，不创建任务',
        `【Executor: ${selectedExecutor}｜回答】`,
        `→ Executor: ${selectedExecutor} 处理本次回答`,
      ];
    }

    return [
      '→ MetaClaw：已识别需要澄清',
      '→ MetaClaw：执行策略：先向用户确认，不创建任务',
    ];
  }

  private async applyTaskControlDecision(
    userInput: string,
    decision: IntentDecisionV2,
    recentTasks: TaskSummary[],
  ): Promise<boolean> {
    if (decision.task.binding === 'reference' && decision.task.taskId) {
      const referencedTask = this.deps.taskRuntimeService.findTask(decision.task.taskId);
      if (!referencedTask) {
        this.deps.callbacks.appendOutput(`错误：任务不存在 ${decision.task.taskId}`);
        return true;
      }

      await this.handleReferencedTaskFromIntent(userInput, referencedTask, decision);
      return true;
    }
    if (decision.task.control === 'status_query') {
      const scope = this.normalizeTaskStatusScope(decision.task.scope);
      this.deps.callbacks.appendOutput(this.deps.presentation.formatTaskStatus({
        scope,
        blockedTasks: this.deps.orchestration.getBlockedTasks(),
        runningTask: this.deps.taskRuntimeService.listTasksByStatus('running')[0] ?? null,
        activeTasks: filterDurableTasks(this.deps.taskRuntimeService.listActiveTasks()),
        latestDone: filterDurableTasks(this.deps.taskRuntimeService.listTasksByStatus('done'))[0] ?? null,
        dashboard: this.deps.orchestration.getDashboard(),
      }));
      this.deps.callbacks.refreshRuntimeState();
      return true;
    }
    if (decision.task.control === 'clear_tasks') {
      const scope = this.normalizeTaskClearScope(decision.task.scope);
      const result = this.deps.taskRuntimeService.clearTasks(scope);
      if (result.runningCancelled) {
        this.deps.executor.abort();
      }
      if (result.cancelled.some(task => task.id === this.deps.callbacks.getCurrentTaskId())) {
        this.deps.callbacks.setCurrentTaskId(null);
        this.deps.callbacks.setFocusContext(null);
      }
      this.deps.callbacks.refreshRuntimeState();
      this.deps.callbacks.appendOutput(this.deps.presentation.formatTaskClearResult({
        scope,
        cancelled: result.cancelled,
        runningCancelled: result.runningCancelled,
      }));
      return true;
    }
    if (decision.task.control === 'recover_blocked') {
      return this.applyResumePlanResult(userInput, this.deps.taskResumePlanner.planBlockedRecovery(userInput), decision);
    }
    if (decision.task.control === 'last_task_continuation') {
      return this.applyResumePlanResult(userInput, await this.deps.taskResumePlanner.planLastTaskContinuation(userInput));
    }
    if (decision.task.control === 'resume_task') {
      return this.applyResumePlanResult(
        userInput,
        await this.deps.taskResumePlanner.planNaturalLanguageResume(userInput),
        decision,
      );
    }
    if (recentTasks.length === 0) {
      this.deps.callbacks.appendOutput('当前没有可操作的任务');
      return true;
    }
    this.deps.callbacks.appendOutput('未找到匹配的任务，可先用 /tasks 查看当前任务清单');
    return true;
  }

  private async createAndPrepareTask(userInput: string, decision: IntentDecisionV2): Promise<void> {
    const includeRecentConversationContext = decision.execution.matchedBoundary?.includes('conversation_follow_up') ?? false;
    const inlineResourceContext = this.deps.memoryContextService.normalizeInlineResourcesFromInput(userInput);
    const task = this.deps.taskRuntimeService.createTask({
      title: inlineResourceContext.normalizedGoal.slice(0, 50),
      goal: inlineResourceContext.normalizedGoal,
      resources: inlineResourceContext.resources,
    });
    await this.applySemanticPriority(task.id, userInput);
    this.deps.callbacks.setCurrentTaskId(task.id);
    this.deps.callbacks.setFocusContext({ kind: 'task', taskId: task.id });
    if (decision.reason === '按当前对话创建跟进任务') {
      this.deps.callbacks.appendOutput(`→ ${decision.reason}`);
    }
    this.deps.callbacks.appendOutput(`任务 #${task.id} 已创建：${task.title}`);
    if (inlineResourceContext.resources.length > 0) {
      this.deps.callbacks.appendOutput(`→ 已自动关联 ${inlineResourceContext.resources.length} 份材料`);
    }

    await this.deps.callbacks.prepareTaskExecution(task.id, {
      userPrompt: userInput,
      contextTaskId: task.id,
      executionMode: 'fresh',
      schedulingReason: buildSchedulingReason(userInput),
      includeRecentConversationContext,
      intentDecision: decision,
    });
  }

  private async handleReferencedTaskFromIntent(
    userInput: string,
    referencedTask: Task,
    intentDecision: IntentDecisionV2,
  ): Promise<void> {
    await this.applyResumePlanResult(userInput, this.deps.taskResumePlanner.planReferencedTask({
      userInput,
      referencedTask,
      intentDecision,
    }), intentDecision);
  }

  private async applyResumePlanResult(
    userInput: string,
    result: ResumePlanResult,
    intentDecision?: IntentDecisionV2,
  ): Promise<boolean> {
    if (result.action === 'not_handled') {
      return false;
    }
    if (result.action === 'message') {
      this.deps.callbacks.appendOutput(...result.lines);
      this.deps.callbacks.refreshRuntimeState();
      return true;
    }
    if (result.action === 'fork_follow_up') {
      const followUpTask = this.deps.taskRuntimeService.createTask(result.plan.newTaskInput);
      await this.applySemanticPriority(followUpTask.id, userInput);
      this.deps.callbacks.setCurrentTaskId(followUpTask.id);
      this.deps.callbacks.setFocusContext({ kind: 'task', taskId: followUpTask.id });
      this.deps.callbacks.appendOutput(...result.lines, `→ 已创建跟进任务 #${followUpTask.id}`);
      await this.deps.callbacks.prepareTaskExecution(followUpTask.id, {
        userPrompt: userInput,
        contextTaskId: result.plan.contextTaskId,
        executionMode: 'follow-up',
        schedulingReason: result.schedulingReason,
        intentDecision,
      });
      return true;
    }
    if (result.action === 'unblock_and_execute') {
      for (const resourcePath of result.newlyProvidedResources ?? []) {
        this.deps.taskRuntimeService.attachResource(result.task.id, resourcePath);
      }
      this.deps.taskRuntimeService.unblockTask(result.task.id);
      this.deps.callbacks.setCurrentTaskId(result.task.id);
      this.deps.callbacks.setFocusContext({ kind: 'task', taskId: result.task.id });
      if (result.observeResumeIntent) {
        await this.deps.taskSemanticService.observeResumeIntent(
          userInput,
          this.deps.callbacks.buildRecentTaskSummaries([result.task]),
        );
      }
      this.deps.callbacks.appendOutput(...result.lines);
      await this.deps.callbacks.prepareTaskExecution(result.task.id, {
        userPrompt: userInput,
        contextTaskId: result.task.id,
        executionMode: 'resume-blocked',
        schedulingReason: result.schedulingReason,
        newlyProvidedResources: result.newlyProvidedResources,
        intentDecision,
        recoveryTrigger: this.deps.callbacks.buildRecoveryTrigger(result.task, {
          kind: result.triggerKind ?? 'natural-language-resume',
          blockedReason: result.blockedReason ?? undefined,
          triggerReason: result.triggerReason,
          sourceInput: userInput,
          newlyProvidedResources: result.newlyProvidedResources,
        }),
      });
      return true;
    }

    this.deps.callbacks.setCurrentTaskId(result.plan.executionTaskId);
    this.deps.callbacks.setFocusContext({ kind: 'task', taskId: result.plan.executionTaskId });
    if (result.observeResumeIntent) {
      await this.deps.taskSemanticService.observeResumeIntent(
        userInput,
        this.deps.callbacks.buildRecentTaskSummaries([result.task]),
      );
      this.resumeParkedTaskIfStillParked(result.task.id);
    }
    this.deps.callbacks.appendOutput(...result.lines);
    await this.applySemanticPriority(result.plan.executionTaskId, userInput);
    await this.deps.callbacks.prepareTaskExecution(result.plan.executionTaskId, {
      userPrompt: userInput,
      contextTaskId: result.plan.contextTaskId,
      executionMode: result.executionMode,
      schedulingReason: result.schedulingReason,
      intentDecision,
    });
    return true;
  }

  private async applySemanticPriority(taskId: string, userInput: string): Promise<void> {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) {
      return;
    }

    const priority = await this.deps.taskSemanticService.classifyPriority(
      userInput,
      { priority: parsePriorityHint(userInput), reason: '规则识别语义优先级' },
    );

    this.deps.taskRuntimeService.updateTask(taskId, {
      prioritySignals: {
        ...task.prioritySignals,
        semanticPriority: priority.priority,
        semanticPriorityReason: priority.reason,
      },
    });
  }

  private resumeParkedTaskIfStillParked(taskId: string): void {
    const latestTask = this.deps.taskRuntimeService.findTask(taskId);
    if (latestTask?.status === 'parked') {
      this.deps.taskRuntimeService.resumeParkedTask(taskId);
    }
  }

  private normalizeTaskStatusScope(scope: string | null): TaskStatusQueryScope {
    return scope === 'blocked' || scope === 'running' || scope === 'dashboard'
      ? scope
      : 'dashboard';
  }

  private normalizeTaskClearScope(scope: string | null): TaskClearScope {
    return scope === 'parked' || scope === 'blocked' || scope === 'all'
      ? scope
      : 'all';
  }
}
