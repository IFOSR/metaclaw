import type Database from 'better-sqlite3';
import type {
  Config,
  GuidanceActionType,
  GuidanceProposal,
  RuntimeState,
  Task,
  TaskRecoveryTrigger,
} from '../core/types.js';
import type { TaskEngine } from '../core/task-engine.js';
import type { MemoryEngine } from '../core/memory-engine.js';
import type { OrchestrationEngine } from '../core/orchestration.js';
import type { ExecutorAdapter } from '../executor/adapter.js';
import { NoopNotificationService, type NotificationService } from '../notifications/types.js';
import type { ContextRecaller } from '../core/context-recaller.js';
import type { LlmBridge, TaskSummary } from '../core/llm-bridge.js';
import { SchedulerEngine } from '../core/scheduler.js';
import type { DispatchContext } from '../core/scheduler.js';
import {
  filterDurableTasks,
  type TaskStatusQueryScope,
} from '../core/task-routing.js';
import { RuleHintsProvider } from '../core/rule-hints-provider.js';
import { IntentOrchestrator, type IntentDecisionV2, type IntentOrchestratorInput } from '../core/intent-orchestrator.js';
import { ResumeContextBuilder } from '../core/resume-context-builder.js';
import { MemoryContextService, type ExecutionRecallSelection } from '../core/memory-context-service.js';
import { RecallPolicyService } from '../core/recall-policy-service.js';
import { RecallReviewApplicationService } from '../core/recall-review-application-service.js';
import { SessionPersistenceService } from '../core/session-persistence-service.js';
import { MemoryCaptureService } from '../core/memory-capture-service.js';
import { ConversationRuntimeService } from '../core/conversation-runtime-service.js';
import { TaskResumePlanner, type ResumePlanResult } from '../core/task-resume-planner.js';
import { CommandRouter } from '../commands/router.js';
import { tasksCommand, taskCommand } from '../commands/task-commands.js';
import { memoryCommand } from '../commands/memory-commands.js';
import { profileCommand } from '../commands/profile-commands.js';
import { executorCommand } from '../commands/executor-commands.js';
import { learningCommand } from '../commands/learning-commands.js';
import { dashboardCommand, attachCommand, historyCommand, configCommand, helpCommand, exitCommand } from '../commands/global-commands.js';
import { isPermissionFailure, isRecoverableExecutorFailure } from '../executor/error-utils.js';
import { RecallReviewPolicyRepo } from '../storage/recall-review-policy-repo.js';
import { SessionStateRepo } from '../storage/session-state-repo.js';
import type { IntentDecision } from '../core/executor-router.js';
import { TaskRuntimeService } from '../core/task-runtime-service.js';
import { TaskSemanticService } from '../core/task-semantic-service.js';
import { ExecutionRuntime, ExecutorRegistry } from '../core/execution-runtime.js';
import { VerificationAndDeliveryService } from '../core/verification-and-delivery-service.js';
import { ExecutorProfileService } from '../core/executor-profile-service.js';
import { ExecutorAdminService } from '../core/executor-admin-service.js';
import { ExecutorRoutingCoordinator } from '../core/executor-routing-coordinator.js';
import { ExecutionProgressService } from '../core/execution-progress-service.js';
import { WorkspaceTargetService } from '../core/workspace-target-service.js';
import { InputController } from './input-controller.js';
import { SessionPresentationService, type GuidanceState } from './session-presentation-service.js';
import { SessionExecutionCoordinator } from './session-execution-coordinator.js';
import {
  buildSchedulingReason,
  isRiskyExternalActionInstruction,
  parseExplicitRemember,
  parsePriorityHint,
  type QueuedExecutionRequest,
} from './session-helpers.js';

export interface MetaclawSessionDeps {
  taskEngine: TaskEngine;
  memoryEngine: MemoryEngine;
  orchestration: OrchestrationEngine;
  executor: ExecutorAdapter;
  db: Database.Database;
  config: Config;
  sessionId: string;
  contextRecaller: ContextRecaller;
  llmBridge: LlmBridge;
  intentOrchestrator?: {
    decide(input: IntentOrchestratorInput): Promise<IntentDecisionV2>;
  };
  notifier?: NotificationService;
  executorFactory?: (name: string) => ExecutorAdapter | null;
  availableExecutorCommands?: Set<string>;
}

export interface SessionSnapshot {
  output: string[];
  currentTaskId: string | null;
  runtimeState: RuntimeState;
  latestGuidance: GuidanceState | null;
}

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

const BUSY_LLM_TIMEOUT_MS = 250;
const DEFAULT_LLM_TIMEOUT_MS = 5_000;

export class MetaclawSession {
  private output: string[] = [];
  private runtimeState: RuntimeState = {
    runningTaskId: null,
    runningExecutorName: null,
    readyTaskIds: [],
    blockedTaskIds: [],
    parkedTaskIds: [],
    lastEvent: null,
  };
  private latestGuidance: GuidanceState | null = null;
  private approvedRecallSelections = new Map<string, ExecutionRecallSelection>();
  private initialized = false;
  private listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private runningExecutorNameByTask = new Map<string, string>();
  private lastReminderAt: number | null = null;
  private lastReminderFingerprint: string | null = null;
  private lastTaskPoolWatchdogReminderAt: number | null = null;
  private lastTaskPoolWatchdogFingerprint: string | null = null;
  private lastBlockedRecheckAt: number | null = null;
  private blockedRecheckInFlight = false;
  private backgroundWork = new Set<Promise<void>>();
  private readonly memoryContextService: MemoryContextService;
  private readonly router: CommandRouter;
  private readonly scheduler: SchedulerEngine<QueuedExecutionRequest>;
  private readonly sessionStateRepo: SessionStateRepo;
  private readonly notifier: NotificationService;
  private readonly inputController: InputController;
  private readonly taskRuntimeService: TaskRuntimeService;
  private readonly taskSemanticService: TaskSemanticService;
  private readonly executionRuntime: ExecutionRuntime;
  private readonly verificationAndDeliveryService: VerificationAndDeliveryService;
  private readonly persistenceService: SessionPersistenceService;
  private readonly conversationRuntimeService: ConversationRuntimeService;
  private readonly memoryCaptureService: MemoryCaptureService;
  private readonly recallReviewApplicationService: RecallReviewApplicationService;
  private readonly taskResumePlanner: TaskResumePlanner;
  private readonly presentation: SessionPresentationService;
  private readonly executorProfileService: ExecutorProfileService;
  private readonly executorAdminService: ExecutorAdminService;
  private readonly executorRoutingCoordinator: ExecutorRoutingCoordinator;
  private readonly executionProgressService: ExecutionProgressService;
  private readonly workspaceTargetService: WorkspaceTargetService;
  private readonly sessionExecutionCoordinator: SessionExecutionCoordinator;
  private readonly intentOrchestrator: {
    decide(input: IntentOrchestratorInput): Promise<IntentDecisionV2>;
  } | null;

  constructor(private deps: MetaclawSessionDeps) {
    this.notifier = deps.notifier ?? new NoopNotificationService();
    this.sessionStateRepo = new SessionStateRepo(deps.db);
    this.intentOrchestrator = deps.intentOrchestrator ?? null;
    this.taskRuntimeService = new TaskRuntimeService({
      taskEngine: deps.taskEngine,
      taskRepo: deps.taskEngine.getTaskRepo(),
      orchestration: deps.orchestration,
    });
    this.taskSemanticService = new TaskSemanticService({
      llmBridge: deps.llmBridge,
      timeoutMs: () => this.getLlmTimeoutMs(),
    });
    this.executorProfileService = new ExecutorProfileService({
      db: deps.db,
      defaultExecutorName: deps.executor.name,
      availableCommands: deps.availableExecutorCommands,
    });
    const executorRegistry = new ExecutorRegistry({
      db: deps.db,
      config: deps.config,
      defaultExecutor: deps.executor,
      executorFactory: deps.executorFactory,
    });
    this.executionRuntime = new ExecutionRuntime(executorRegistry, deps.executor);
    this.verificationAndDeliveryService = new VerificationAndDeliveryService();
    this.persistenceService = new SessionPersistenceService(deps.db);
    this.presentation = new SessionPresentationService();
    this.executorAdminService = new ExecutorAdminService({
      profileService: this.executorProfileService,
      presentation: this.presentation,
    });
    this.executorRoutingCoordinator = new ExecutorRoutingCoordinator({
      profileService: this.executorProfileService,
      taskRuntimeService: this.taskRuntimeService,
      persistenceService: this.persistenceService,
      defaultExecutorName: deps.executor.name,
    });
    this.executionProgressService = new ExecutionProgressService(deps.db);
    this.workspaceTargetService = new WorkspaceTargetService();
    this.memoryContextService = new MemoryContextService({
      memoryEngine: deps.memoryEngine,
      contextRecaller: deps.contextRecaller,
      resumeContextBuilder: new ResumeContextBuilder(
        deps.taskEngine,
        deps.memoryEngine,
        deps.contextRecaller,
      ),
    });
    this.conversationRuntimeService = new ConversationRuntimeService({
      executor: deps.executor,
      memoryContextService: this.memoryContextService,
      persistenceService: this.persistenceService,
    });
    this.memoryCaptureService = new MemoryCaptureService({
      db: deps.db,
      memoryEngine: deps.memoryEngine,
      notifier: this.notifier,
      deliveryService: this.verificationAndDeliveryService,
    });
    this.recallReviewApplicationService = new RecallReviewApplicationService({
      memoryContextService: this.memoryContextService,
      recallPolicyService: this.createRecallPolicyService(),
      memoryCaptureService: this.memoryCaptureService,
      formatters: this.presentation,
    });
    this.taskResumePlanner = new TaskResumePlanner({
      taskRuntimeService: this.taskRuntimeService,
      taskSemanticService: this.taskSemanticService,
      sessionStateRepo: this.sessionStateRepo,
    });
    this.router = createDefaultCommandRouter();
    this.scheduler = new SchedulerEngine<QueuedExecutionRequest>(
      deps.taskEngine,
      deps.orchestration,
      deps.executor,
      async (taskId: string, context?: DispatchContext<QueuedExecutionRequest>) => this.dispatchTask(taskId, context),
      async (tasks: Task[]) => this.classifyMissingSemanticPriorities(tasks),
      this.taskRuntimeService,
    );
    this.inputController = new InputController({
      appendUserInput: (input: string) => this.appendUserInput(input),
      hasPendingExecutorRegisterWizard: () => this.executorAdminService.hasPendingWizard(),
      handlePendingExecutorRegisterWizard: (input: string) => this.handlePendingExecutorRegisterWizardInput(input),
      handleCommand: (input: string) => this.handleCommand(input),
      handleNaturalLanguageInput: (input: string) => this.handleNaturalLanguageInput(input),
      waitForAsyncWork: () => this.waitForAsyncWork(),
      handleSubmitError: (error: unknown) => this.appendOutput(`错误: ${(error as Error).message}`),
    });
    this.sessionExecutionCoordinator = new SessionExecutionCoordinator({
      sessionId: deps.sessionId,
      memoryEngine: deps.memoryEngine,
      orchestration: deps.orchestration,
      notifier: this.notifier,
      taskRuntimeService: this.taskRuntimeService,
      memoryContextService: this.memoryContextService,
      executorRoutingCoordinator: this.executorRoutingCoordinator,
      executionRuntime: this.executionRuntime,
      scheduler: this.scheduler,
      executionProgressService: this.executionProgressService,
      workspaceTargetService: this.workspaceTargetService,
      verificationAndDeliveryService: this.verificationAndDeliveryService,
      persistenceService: this.persistenceService,
      memoryCaptureService: this.memoryCaptureService,
      presentation: this.presentation,
      callbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        refreshRuntimeState: () => this.refreshRuntimeState(),
        appendTaskQueueSnapshot: trigger => this.appendTaskQueueSnapshot(trigger),
        setFocusContext: focus => this.setFocusContext(focus),
        setRunningExecutorName: (taskId, name) => this.runningExecutorNameByTask.set(taskId, name),
        clearRunningExecutorName: taskId => this.runningExecutorNameByTask.delete(taskId),
        persistSessionState: changes => this.persistSessionState(changes),
        setLatestGuidance: (scene, suggestion) => this.setLatestGuidance(scene, suggestion),
        queueProposal: (scene, proposal) => this.queueProposal(scene, proposal),
      },
    });
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): SessionSnapshot {
    this.reconcileLatestGuidance();
    return {
      output: [...this.output],
      currentTaskId: this.getCurrentTaskId(),
      runtimeState: this.runtimeState,
      latestGuidance: this.latestGuidance
        ? {
            ...this.latestGuidance,
            reasons: [...this.latestGuidance.reasons],
          }
        : null,
    };
  }

  private reconcileLatestGuidance(): void {
    if (!this.latestGuidance) {
      return;
    }

    const task = this.taskRuntimeService.findTask(this.latestGuidance.taskId);
    if (!task || !['created', 'ready', 'running', 'parked', 'blocked'].includes(task.status)) {
      this.latestGuidance = null;
      return;
    }

    if (this.latestGuidance.taskTitle !== task.title) {
      this.latestGuidance = {
        ...this.latestGuidance,
        taskTitle: task.title,
      };
    }
  }

  initialize(options: { resumeStartupTasks?: boolean; showDashboard?: boolean } = {}): void {
    if (this.initialized) return;

    this.seedExecutorRegistry();

    const resumeStartupTasks = options.resumeStartupTasks ?? true;
    const showDashboard = options.showDashboard ?? true;
    const recoveredRunningTasks = resumeStartupTasks ? this.recoverOrphanedRunningTasks() : [];

    if (showDashboard && this.deps.config.ui.dashboard_on_start) {
      const dashboard = this.deps.orchestration.getDashboard();
      this.output = [
        '┌─ Metaclaw v1.0 ─────────────────────────────────┐',
        `│ 你有 ${dashboard.summary.active} 个活跃任务，${dashboard.summary.blocked} 个 Blocked。`,
      ];

      if (dashboard.priorityTask) {
        this.output.push(`│ 建议优先：#${dashboard.priorityTask.id} ${dashboard.priorityTask.title}`);
        dashboard.priorityTask.reasons.forEach(reason => this.output.push(`│   → ${reason}`));
      }

      this.output.push('└──────────────────────────────────────────────────┘');

      if (dashboard.priorityTask) {
        this.appendGuidance('启动建议', {
          taskId: dashboard.priorityTask.id,
          recommendedAction: `优先处理任务 #${dashboard.priorityTask.id}: ${dashboard.priorityTask.title}`,
          reasons: dashboard.priorityTask.reasons,
        });
      }
    }

    if (recoveredRunningTasks.length > 0) {
      for (const task of recoveredRunningTasks) {
        this.output.push(
          `→ 检测到上次异常退出，任务 #${task.id} 已转为挂起`,
          `→ 可执行 /task ${task.id} resume 继续，或直接说“继续刚才那个任务”`,
        );
      }
    }

    const startupProposal = resumeStartupTasks ? this.deps.orchestration.generateProposals('startup')[0] : null;
    if (startupProposal) {
      this.queueProposal('启动建议', startupProposal);
    }

    this.initialized = true;
    this.refreshRuntimeState();
    this.notify();
    if (resumeStartupTasks) {
      this.resumeUnfinishedTasksOnStartup(recoveredRunningTasks);
    }
  }

  async submit(
    rawInput: string,
    options: { awaitAsyncWork?: boolean } = {},
  ): Promise<{ exitRequested: boolean }> {
    return this.inputController.submit(rawInput, options);
  }

  async waitForAsyncWork(): Promise<void> {
    while (this.backgroundWork.size > 0) {
      await Promise.allSettled(Array.from(this.backgroundWork));
    }
    await this.scheduler.waitForIdle();
  }

  appendSystemMessage(...lines: string[]): void {
    this.appendOutput(...lines);
  }

  private appendUserInput(userInput: string): void {
    this.appendOutput('', `> ${userInput}`);
  }

  maybeEmitIdleGuidance(nowMs = Date.now()): boolean {
    if (!this.deps.config.orchestration.reminder_enabled) {
      return false;
    }

    const suggestions = this.deps.orchestration.generateSuggestions();
    if (suggestions.length === 0) {
      return false;
    }

    const suggestion = suggestions[0];
    const fingerprint = `${suggestion.type}:${suggestion.taskId}:${suggestion.reasons.join('|')}`;
    const throttleMs = this.deps.config.orchestration.reminder_throttle * 1000;

    if (
      this.lastReminderFingerprint === fingerprint
      && this.lastReminderAt !== null
      && nowMs - this.lastReminderAt < throttleMs
    ) {
      return false;
    }

    this.lastReminderAt = nowMs;
    this.lastReminderFingerprint = fingerprint;
    this.setLatestGuidance('空闲提醒', suggestion);
    this.appendOutput(
      '',
      `💡 提醒：${suggestion.recommendedAction}`,
      `   → 目标任务：#${suggestion.taskId}${this.buildSuggestionTaskTitleSuffix(suggestion.taskId)}`,
      ...suggestion.reasons.map(reason => `   → ${reason}`),
    );
    return true;
  }

  async maybeReconcileBlockedTasksOnTimer(nowMs = Date.now()): Promise<boolean> {
    if (this.blockedRecheckInFlight) {
      return false;
    }

    const orchestrationConfig = this.deps.config.orchestration;
    if (orchestrationConfig.blocked_recheck_enabled === false) {
      return false;
    }

    const intervalMs = Math.max(orchestrationConfig.blocked_recheck_interval ?? 60, 5) * 1000;
    if (
      this.lastBlockedRecheckAt !== null
      && nowMs - this.lastBlockedRecheckAt < intervalMs
    ) {
      return false;
    }

    const candidates = this.findTimerRecheckableBlockedTasks();
    if (candidates.length === 0) {
      this.lastBlockedRecheckAt = nowMs;
      return false;
    }

    this.lastBlockedRecheckAt = nowMs;
    this.blockedRecheckInFlight = true;
    try {
      const executorAvailable = await this.deps.executor.isAvailable();
      if (!executorAvailable) {
        return false;
      }

      const target = candidates[0];
      const blockedReason = this.getWaitingBlockReason(target) || '未知原因';
      this.taskRuntimeService.unblockTask(target.id);
      this.setCurrentTaskId(target.id);
      this.setFocusContext({ kind: 'task', taskId: target.id });
      this.appendOutput(
        `→ 定时检查：任务 #${target.id} 的阻塞条件可能已恢复`,
        `→ 原阻塞原因：${blockedReason}`,
        '→ 已解除阻塞并重新进入调度',
      );
      await this.prepareTaskExecution(target.id, {
        userPrompt: target.goal,
        contextTaskId: target.id,
        executionMode: 'resume-blocked',
        origin: 'system',
        schedulingReason: '定时检查确认执行器可用，恢复阻塞任务',
        recoveryTrigger: this.buildRecoveryTrigger(target, {
          kind: 'timer-recheck',
          blockedReason,
          triggerReason: '定时检查确认执行器可用',
        }),
      });
      return true;
    } finally {
      this.blockedRecheckInFlight = false;
      this.refreshRuntimeState();
    }
  }

  getBlockedRecheckIntervalMs(): number {
    const seconds = this.deps.config.orchestration.blocked_recheck_interval ?? 60;
    return Math.max(seconds, 5) * 1000;
  }

  async maybeReviewTaskPoolOnTimer(nowMs = Date.now()): Promise<boolean> {
    if (await this.maybeReconcileBlockedTasksOnTimer(nowMs)) {
      return true;
    }

    const beforeState = this.scheduler.getRuntimeState();
    const scheduledTaskId = await this.scheduler.scheduleNext();
    this.refreshRuntimeState();

    if (!beforeState.runningTaskId && scheduledTaskId) {
      const task = this.taskRuntimeService.findTask(scheduledTaskId);
      if (task) {
        this.appendOutput(
          `→ 任务池看护：发现可执行任务 #${task.id} ${task.title}`,
          '→ 已自动进入调度执行',
        );
      }
      return true;
    }

    return this.maybeEmitTaskPoolWatchdogReminder(nowMs);
  }

  private findTimerRecheckableBlockedTasks(): Task[] {
    return filterDurableTasks(this.taskRuntimeService.listTasks())
      .filter(task => task.status === 'blocked')
      .filter(task => this.isTimerRecheckableBlockedTask(task))
      .sort((left, right) => new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime());
  }

  private isTimerRecheckableBlockedTask(task: Task): boolean {
    const reason = this.getWaitingBlockReason(task);
    if (!reason) {
      return false;
    }

    if (isPermissionFailure(reason)) {
      return false;
    }

    if (/材料|文件|链接|文档|资料|补充|缺少|等待|授权|权限|permission|authorized|access/i.test(reason)) {
      return false;
    }

    return isRecoverableExecutorFailure(reason);
  }

  private getWaitingBlockReason(task: Task): string {
    return task.dependencies
      .filter(dependency => dependency.status === 'waiting')
      .map(dependency => dependency.description)
      .filter(Boolean)
      .join('；');
  }

  private buildRecoveryTrigger(
    task: Task,
    input: {
      kind: TaskRecoveryTrigger['kind'];
      triggerReason: string;
      sourceInput?: string;
      blockedReason?: string;
      newlyProvidedResources?: string[];
    },
  ): TaskRecoveryTrigger {
    return {
      kind: input.kind,
      blockedReason: input.blockedReason || this.getWaitingBlockReason(task) || '未知原因',
      triggerReason: input.triggerReason,
      sourceInputExcerpt: input.sourceInput ? this.excerptInput(input.sourceInput) : undefined,
      newlyProvidedResources: input.newlyProvidedResources,
    };
  }

  private excerptInput(input: string, maxLength = 80): string {
    const normalized = input.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, maxLength - 1)}…`;
  }

  private maybeEmitTaskPoolWatchdogReminder(nowMs: number): boolean {
    if (!this.deps.config.orchestration.reminder_enabled) {
      return false;
    }

    const blockedTasks = filterDurableTasks(this.taskRuntimeService.listTasks())
      .filter(task => task.status === 'blocked');
    const parkedTasks = filterDurableTasks(this.taskRuntimeService.listTasks())
      .filter(task => task.status === 'parked');
    if (blockedTasks.length === 0 && parkedTasks.length === 0) {
      return false;
    }

    const fingerprint = [
      ...blockedTasks.map(task => `b:${task.id}:${this.getWaitingBlockReason(task)}`),
      ...parkedTasks.map(task => `p:${task.id}:${task.lastInterruptionReason}:${task.snapshots.at(-1)?.nextStep ?? ''}`),
    ].join('|');
    const throttleMs = this.deps.config.orchestration.reminder_throttle * 1000;
    if (
      this.lastTaskPoolWatchdogFingerprint === fingerprint
      && this.lastTaskPoolWatchdogReminderAt !== null
      && nowMs - this.lastTaskPoolWatchdogReminderAt < throttleMs
    ) {
      return false;
    }

    this.lastTaskPoolWatchdogFingerprint = fingerprint;
    this.lastTaskPoolWatchdogReminderAt = nowMs;
    this.appendOutput(...this.presentation.formatTaskPoolWatchdogReminder({
      blockedTasks,
      parkedTasks,
      getWaitingBlockReason: task => this.getWaitingBlockReason(task),
    }));
    return true;
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach(listener => listener(snapshot));
  }

  private buildSuggestionTaskTitleSuffix(taskId: string): string {
    const task = this.taskRuntimeService.findTask(taskId);
    if (!task?.title) {
      return '';
    }

    return ` ${task.title}`;
  }

  private setLatestGuidance(
    scene: string,
    suggestion: { taskId: string; recommendedAction: string; reasons: string[] },
  ): GuidanceState {
    this.latestGuidance = this.presentation.buildGuidanceState(
      scene,
      suggestion,
      this.taskRuntimeService.findTask(suggestion.taskId)?.title ?? '',
    );
    return this.latestGuidance;
  }

  private appendGuidance(
    scene: string,
    suggestion: { taskId: string; recommendedAction: string; reasons: string[] },
  ): void {
    this.setLatestGuidance(scene, suggestion);
    this.appendOutput(
      ...this.presentation.formatGuidanceBlock(scene, suggestion, this.latestGuidance?.taskTitle ?? ''),
    );
  }

  private queueProposal(scene: string, proposal: GuidanceProposal): void {
    this.appendOutput(...this.presentation.formatProposalBlock(
      scene,
      proposal,
      proposal.taskId ? this.taskRuntimeService.findTask(proposal.taskId)?.title ?? '' : '',
    ));
    this.appendOutput('→ 操作提案已记录，不等待用户确认；满足执行条件的任务由调度器自动处理');
  }

  private createRecallPolicyService(): RecallPolicyService {
    return new RecallPolicyService(new RecallReviewPolicyRepo(this.deps.db));
  }

  private seedExecutorRegistry(): void {
    this.executorProfileService.seedDefaults();
  }

  private async maybeHandleIntentOrchestratorDecision(
    userInput: string,
    options: { suppressSafetyGuardHints?: boolean } = {},
  ): Promise<boolean> {
    const recentTasks = this.buildRecentTaskSummaries(this.taskRuntimeService.listTasks());
    const decision = await this.getIntentOrchestrator().decide(
      this.buildIntentOrchestratorInput(userInput, recentTasks, options),
    );

    if (decision.interactionType === 'clarification') {
      this.appendIntentClarification(userInput, decision);
      return true;
    }

    if (decision.interactionType === 'direct_reply') {
      if (decision.reason === '延续当前对话，不恢复旧任务') {
        this.appendOutput(`→ ${decision.reason}`);
      }
      await this.runConversationInput(userInput);
      return true;
    }

    if (decision.interactionType === 'task_control') {
      if (decision.task.binding === 'reference' && decision.task.taskId) {
        const referencedTask = this.taskRuntimeService.findTask(decision.task.taskId);
        if (!referencedTask) {
          this.appendOutput(`错误：任务不存在 ${decision.task.taskId}`);
          return true;
        }

        await this.handleReferencedTaskFromIntent(userInput, referencedTask, decision);
        return true;
      }
      if (decision.task.control === 'status_query') {
        const scope = this.normalizeTaskStatusScope(decision.task.scope);
        this.appendOutput(this.presentation.formatTaskStatus({
          scope,
          blockedTasks: this.deps.orchestration.getBlockedTasks(),
          runningTask: this.taskRuntimeService.listTasksByStatus('running')[0] ?? null,
          activeTasks: filterDurableTasks(this.taskRuntimeService.listActiveTasks()),
          latestDone: filterDurableTasks(this.taskRuntimeService.listTasksByStatus('done'))[0] ?? null,
          dashboard: this.deps.orchestration.getDashboard(),
        }));
        this.refreshRuntimeState();
        return true;
      }
      if (decision.task.control === 'clear_tasks') {
        const scope = this.normalizeTaskClearScope(decision.task.scope);
        const result = this.taskRuntimeService.clearTasks(scope);
        if (result.runningCancelled) {
          this.deps.executor.abort();
        }
        if (result.cancelled.some(task => task.id === this.getCurrentTaskId())) {
          this.setCurrentTaskId(null);
          this.setFocusContext(null);
        }
        this.refreshRuntimeState();
        this.appendOutput(this.presentation.formatTaskClearResult({
          scope,
          cancelled: result.cancelled,
          runningCancelled: result.runningCancelled,
        }));
        return true;
      }
      if (decision.task.control === 'recover_blocked') {
        return this.applyResumePlanResult(userInput, this.taskResumePlanner.planBlockedRecovery(userInput), decision);
      }
      if (decision.task.control === 'last_task_continuation') {
        return this.executeLastTaskContinuationFromIntent(userInput);
      }
      if (decision.task.control === 'resume_task') {
        return this.applyResumePlanResult(
          userInput,
          await this.taskResumePlanner.planNaturalLanguageResume(userInput),
          decision,
        );
      }
      if (recentTasks.length === 0) {
        this.appendOutput('当前没有可操作的任务');
        return true;
      }
      this.appendOutput('未找到匹配的任务，可先用 /tasks 查看当前任务清单');
      return true;
    }

    if (decision.task.binding === 'reference' && decision.task.taskId) {
      const referencedTask = this.taskRuntimeService.findTask(decision.task.taskId);
      if (!referencedTask) {
        this.appendOutput(`错误：任务不存在 ${decision.task.taskId}`);
        return true;
      }

      await this.handleReferencedTaskFromIntent(userInput, referencedTask, decision);
      return true;
    }

    const includeRecentConversationContext = decision.execution.matchedBoundary?.includes('conversation_follow_up') ?? false;
    const inlineResourceContext = this.memoryContextService.normalizeInlineResourcesFromInput(userInput);
    const task = this.taskRuntimeService.createTask({
      title: inlineResourceContext.normalizedGoal.slice(0, 50),
      goal: inlineResourceContext.normalizedGoal,
      resources: inlineResourceContext.resources,
    });
    await this.applySemanticPriority(task.id, userInput);
    this.setCurrentTaskId(task.id);
    this.setFocusContext({ kind: 'task', taskId: task.id });
    if (decision.reason === '按当前对话创建跟进任务') {
      this.appendOutput(`→ ${decision.reason}`);
    }
    this.appendOutput(`任务 #${task.id} 已创建：${task.title}`);
    if (inlineResourceContext.resources.length > 0) {
      this.appendOutput(`→ 已自动关联 ${inlineResourceContext.resources.length} 份材料`);
    }

    await this.prepareTaskExecution(task.id, {
      userPrompt: userInput,
      contextTaskId: task.id,
      executionMode: 'fresh',
      schedulingReason: buildSchedulingReason(userInput),
      includeRecentConversationContext,
      intentDecision: decision,
    });
    return true;
  }

  private getIntentOrchestrator(): {
    decide(input: IntentOrchestratorInput): Promise<IntentDecisionV2>;
  } {
    if (this.intentOrchestrator) {
      return this.intentOrchestrator;
    }

    const executorProfiles = this.executorProfileService.listProfiles();
    return IntentOrchestrator.createDefault({
      llmBridge: this.deps.llmBridge,
      executorProfiles,
      defaultExecutorName: this.deps.executor.name,
      llmTimeoutMs: this.getLlmTimeoutMs(),
    });
  }

  private buildRecentTaskSummaries(tasks: Task[]): TaskSummary[] {
    return tasks.map(task => ({
      id: task.id,
      title: task.title,
      goal: task.goal,
      summary: task.summary,
      status: task.status,
    }));
  }

  private buildIntentOrchestratorInput(
    userInput: string,
    recentTasks: TaskSummary[],
    options: { suppressSafetyGuardHints?: boolean } = {},
  ): IntentOrchestratorInput {
    const executorProfiles = this.executorProfileService.listProfiles();
    const hints = new RuleHintsProvider(process.cwd()).collect(userInput);
    return {
      userInput,
      recentTasks,
      executorProfiles,
      defaultExecutorName: this.deps.executor.name,
      currentFocus: this.getFocusContext(),
      hints: options.suppressSafetyGuardHints
        ? hints.filter(hint => hint.source !== 'safety_guard')
        : hints,
      allowDurableTask: true,
      allowFileModification: true,
      timeoutMs: this.getLlmTimeoutMs(),
    };
  }

  private appendIntentClarification(userInput: string, decision: IntentDecisionV2): void {
    this.appendOutput(
      '→ 统一意图裁决置信度不足，未创建任务、未恢复旧任务、未派发执行器。',
      `→ 输入：${userInput}`,
      `→ 判断：${decision.reason || '无可靠语义裁决'} (confidence=${decision.confidence.toFixed(2)})`,
      decision.clarificationQuestion
        || '我不确定你是想继续聊天、创建新任务，还是恢复某个已有任务。请明确说明下一步动作。',
    );
  }

  private normalizeTaskStatusScope(scope: string | null): TaskStatusQueryScope {
    return scope === 'blocked' || scope === 'running' || scope === 'dashboard'
      ? scope
      : 'dashboard';
  }

  private normalizeTaskClearScope(scope: string | null): 'all' | 'parked' | 'blocked' {
    return scope === 'parked' || scope === 'blocked' || scope === 'all'
      ? scope
      : 'all';
  }

  private async handleReferencedTaskFromIntent(
    userInput: string,
    referencedTask: Task,
    intentDecision: IntentDecisionV2,
  ): Promise<void> {
    await this.applyResumePlanResult(userInput, this.taskResumePlanner.planReferencedTask({
      userInput,
      referencedTask,
      intentDecision,
    }), intentDecision);
  }

  private async prepareTaskExecution(
    taskId: string,
    request: QueuedExecutionRequest,
    proposalType: GuidanceActionType | null = null,
  ): Promise<void> {
    const task = this.taskRuntimeService.findTask(taskId);
    if (!task) {
      this.appendOutput(`错误：任务不存在 ${taskId}`);
      return;
    }

    const recallApplication = await this.recallReviewApplicationService.apply({
      taskId,
      userPrompt: request.userPrompt,
      taskTitle: task.title,
      proposalType,
    });
    this.approvedRecallSelections.set(taskId, recallApplication.approvedSelection);
    this.appendOutput(...recallApplication.lines);

    await this.submitScheduledTask(taskId, request);
  }

  private maybeAppendExecutionGuidance(task: Task, request: QueuedExecutionRequest): void {
    if (request.executionMode === 'resume-blocked') {
      this.appendGuidance('解除阻塞后恢复', this.presentation.formatBlockedExecutionGuidance(
        task,
        request.newlyProvidedResources,
      ));
      return;
    }

    if (request.executionMode === 'resume-parked') {
      this.appendGuidance('恢复已挂起任务', this.presentation.formatResumeExecutionGuidance(task));
    }
  }

  private appendOutput(...lines: string[]): void {
    if (lines.length === 0) return;
    this.output.push(...lines);
    this.notify();
  }

  private setCurrentTaskId(taskId: string | null): void {
    this.taskRuntimeService.setCurrentTaskId(taskId);
    this.notify();
  }

  private getCurrentTaskId(): string | null {
    return this.taskRuntimeService.getCurrentTaskId();
  }

  private refreshRuntimeState(): void {
    const schedulerState = this.scheduler.getRuntimeState();
    this.runtimeState = {
      ...schedulerState,
      runningExecutorName: schedulerState.runningTaskId
        ? this.runningExecutorNameByTask.get(schedulerState.runningTaskId) ?? null
        : null,
    };
    this.notify();
  }

  private appendTaskQueueSnapshot(trigger: string): void {
    const entries = this.buildTaskQueueSnapshotEntries();
    if (entries.length === 0) {
      return;
    }

    this.appendOutput(...this.presentation.formatTaskQueueSnapshot({
      trigger,
      runtimeState: this.runtimeState,
      entries,
    }));
  }

  private buildTaskQueueSnapshotEntries() {
    return this.presentation.buildTaskQueueSnapshotEntries({
      tasks: filterDurableTasks(this.taskRuntimeService.listTasks()),
      runningTaskId: this.runtimeState.runningTaskId,
      evaluateTask: task => this.deps.orchestration.evaluateTask(task),
    });
  }

  private persistSessionState(changes: {
    lastFocusedTaskId?: string | null;
    lastCompletedTaskId?: string | null;
    lastSessionId?: string | null;
  }): void {
    this.sessionStateRepo.upsert(changes);
  }

  private async executeLastTaskContinuationFromIntent(userInput: string): Promise<boolean> {
    const result = await this.taskResumePlanner.planLastTaskContinuation(userInput);
    return this.applyResumePlanResult(userInput, result);
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
      this.appendOutput(...result.lines);
      this.refreshRuntimeState();
      return true;
    }
    if (result.action === 'fork_follow_up') {
      const followUpTask = this.taskRuntimeService.createTask(result.plan.newTaskInput);
      await this.applySemanticPriority(followUpTask.id, userInput);
      this.setCurrentTaskId(followUpTask.id);
      this.setFocusContext({ kind: 'task', taskId: followUpTask.id });
      this.appendOutput(...result.lines, `→ 已创建跟进任务 #${followUpTask.id}`);
      await this.prepareTaskExecution(followUpTask.id, {
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
        this.taskRuntimeService.attachResource(result.task.id, resourcePath);
      }
      this.taskRuntimeService.unblockTask(result.task.id);
      this.setCurrentTaskId(result.task.id);
      this.setFocusContext({ kind: 'task', taskId: result.task.id });
      if (result.observeResumeIntent) {
        await this.taskSemanticService.observeResumeIntent(
          userInput,
          this.buildRecentTaskSummaries([result.task]),
        );
      }
      this.appendOutput(...result.lines);
      await this.prepareTaskExecution(result.task.id, {
        userPrompt: userInput,
        contextTaskId: result.task.id,
        executionMode: 'resume-blocked',
        schedulingReason: result.schedulingReason,
        newlyProvidedResources: result.newlyProvidedResources,
        intentDecision,
        recoveryTrigger: this.buildRecoveryTrigger(result.task, {
          kind: result.triggerKind ?? 'natural-language-resume',
          blockedReason: result.blockedReason ?? undefined,
          triggerReason: result.triggerReason,
          sourceInput: userInput,
          newlyProvidedResources: result.newlyProvidedResources,
        }),
      });
      return true;
    }

    this.setCurrentTaskId(result.plan.executionTaskId);
    this.setFocusContext({ kind: 'task', taskId: result.plan.executionTaskId });
    if (result.observeResumeIntent) {
      await this.taskSemanticService.observeResumeIntent(
        userInput,
        this.buildRecentTaskSummaries([result.task]),
      );
      this.resumeParkedTaskIfStillParked(result.task.id);
    }
    this.appendOutput(...result.lines);
    await this.applySemanticPriority(result.plan.executionTaskId, userInput);
    await this.prepareTaskExecution(result.plan.executionTaskId, {
      userPrompt: userInput,
      contextTaskId: result.plan.contextTaskId,
      executionMode: result.executionMode,
      schedulingReason: result.schedulingReason,
      intentDecision,
    });
    return true;
  }

  private async handleCommand(userInput: string): Promise<boolean> {
    const result = await this.router.execute(userInput, {
      taskEngine: this.deps.taskEngine,
      memoryEngine: this.deps.memoryEngine,
      orchestration: this.deps.orchestration,
      executor: this.deps.executor,
      currentTaskId: this.getCurrentTaskId(),
      db: this.deps.db,
      config: this.deps.config,
    });

    this.appendOutput(result.content);

    const commandData = result.data as
      | {
          executorRegisterWizard?: boolean;
        }
      | undefined;
    if (commandData?.executorRegisterWizard) {
      this.appendOutput(...this.executorAdminService.startWizard());
    }

    if (result.type === 'exit') {
      this.persistSessionState({ lastSessionId: this.deps.sessionId });
      return true;
    }

    const schedulerData = result.data as
      | {
          schedulerAction?: 'resume';
          taskId?: string;
          mode?: QueuedExecutionRequest['executionMode'];
          newlyProvidedResources?: string[];
          blockedReason?: string;
        }
      | undefined;

    if (schedulerData?.schedulerAction === 'resume' && schedulerData.taskId && schedulerData.mode) {
      const resumedTask = this.taskRuntimeService.findTask(schedulerData.taskId);
      if (resumedTask) {
        this.setCurrentTaskId(resumedTask.id);
        await this.prepareTaskExecution(resumedTask.id, {
          userPrompt: resumedTask.goal,
          contextTaskId: resumedTask.id,
          executionMode: schedulerData.mode,
          schedulingReason: schedulerData.mode === 'resume-blocked' ? '阻塞已解除' : '恢复已挂起任务',
          newlyProvidedResources: schedulerData.newlyProvidedResources,
          recoveryTrigger: schedulerData.mode === 'resume-blocked'
            ? this.buildRecoveryTrigger(resumedTask, {
                kind: 'explicit-task-command',
                blockedReason: schedulerData.blockedReason,
                triggerReason: schedulerData.newlyProvidedResources?.length
                  ? '显式解除阻塞并补充材料'
                  : '显式解除阻塞',
                sourceInput: userInput,
                newlyProvidedResources: schedulerData.newlyProvidedResources,
              })
            : undefined,
        });
      }
    }

    return false;
  }

  private async handlePendingExecutorRegisterWizardInput(userInput: string): Promise<boolean> {
    const result = await this.executorAdminService.handlePendingWizardInput(userInput);
    this.appendOutput(...result.lines);
    return result.handled;
  }

  private async handleNaturalLanguageInput(
    userInput: string,
    options: { skipRiskConfirmation?: boolean } = {},
  ): Promise<void> {
    const explicitRemember = parseExplicitRemember(userInput);
    if (explicitRemember) {
      const pref = this.deps.memoryEngine.addManual({
        content: explicitRemember,
        scope: 'global',
        type: 'domain',
      });
      this.appendOutput(`已记住偏好 #${pref.id}: ${pref.content}`);
      return;
    }

    const highConfidencePreferenceCapture = this.memoryCaptureService.captureHighConfidencePreferences(
      userInput,
      `session:${this.deps.sessionId}`,
    );
    if (highConfidencePreferenceCapture.lines.length > 0) {
      this.appendOutput(...highConfidencePreferenceCapture.lines);
      return;
    }

    const riskAlreadyWarned = !options.skipRiskConfirmation && isRiskyExternalActionInstruction(userInput);
    if (riskAlreadyWarned) {
      this.appendOutput(
        '⚠️ 检测到高风险外部动作。',
        '→ 当前通道不等待用户确认，已按原请求继续执行；执行器仍需遵守系统安全边界。',
      );
    }

    if (await this.maybeHandleIntentOrchestratorDecision(userInput, {
      suppressSafetyGuardHints: riskAlreadyWarned,
    })) {
      return;
    }

    this.appendIntentClarification(userInput, {
      interactionType: 'clarification',
      confidence: 0,
      reason: '统一意图裁决未产生可执行动作',
      clarificationQuestion: '我不确定你是要聊天、创建新任务、恢复旧任务还是派发执行器。请明确说明下一步动作。',
      risk: { level: 'low', requiresConfirmation: false, reasons: [] },
      task: { binding: 'none', taskId: null, control: 'none', scope: null },
      execution: {
        mode: 'none',
        complexity: 'simple',
        selectedExecutor: null,
        candidateExecutors: [],
        requiresVerification: false,
        canModifyFiles: false,
        requiresExternalGateway: false,
        matchedBoundary: [],
      },
      hints: [],
    });
  }

  private async applySemanticPriority(taskId: string, userInput: string): Promise<void> {
    const task = this.taskRuntimeService.findTask(taskId);
    if (!task) {
      return;
    }

    const priority = await this.taskSemanticService.classifyPriority(
      userInput,
      { priority: parsePriorityHint(userInput), reason: '规则识别语义优先级' },
    );

    this.taskRuntimeService.updateTask(taskId, {
      prioritySignals: {
        ...task.prioritySignals,
        semanticPriority: priority.priority,
        semanticPriorityReason: priority.reason,
      },
    });
  }

  private async classifyMissingSemanticPriorities(tasks: Task[]): Promise<void> {
    for (const task of tasks) {
      const current = this.taskRuntimeService.findTask(task.id);
      if (!current || current.prioritySignals.semanticPriority) {
        continue;
      }

      await this.applySemanticPriority(current.id, current.goal || current.title);
    }
  }

  private getLlmTimeoutMs(): number {
    return this.runtimeState.runningTaskId ? BUSY_LLM_TIMEOUT_MS : DEFAULT_LLM_TIMEOUT_MS;
  }

  private async awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | null = null;

    try {
      return await Promise.race([
        promise,
        new Promise<T>(resolve => {
          timer = setTimeout(() => resolve(fallback), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async runConversationInput(userInput: string): Promise<void> {
    const result = await this.conversationRuntimeService.run({
      sessionId: this.deps.sessionId,
      userInput,
    });
    if (result.focus) {
      this.setFocusContext(result.focus);
    }
    this.appendOutput(...result.lines);
  }

  private async submitScheduledTask(taskId: string, request: QueuedExecutionRequest): Promise<void> {
    const result = await this.scheduler.submit(taskId, {
      reason: request.schedulingReason || '新任务提交',
      executionRequest: request,
    });
    this.refreshRuntimeState();

    if (result.action === 'queued') {
      this.appendOutput(`→ 任务 #${taskId} 已进入待执行队列`);
      this.appendTaskQueueSnapshot('任务进入待执行队列');
      return;
    }

    if (result.action === 'preempted') {
      this.appendOutput(
        `→ 高优任务到达，抢占当前任务 #${result.preemptedTaskId}`,
        `→ 原因：${request.schedulingReason || '用户显式要求优先处理'}`,
        `→ 任务 #${result.preemptedTaskId} 已挂起，开始执行 #${taskId}`,
        `→ 执行准备：先由 ${this.deps.executor.name} 解析意图与构建上下文，随后按路由派发到具体 Executor`,
      );
      this.appendTaskQueueSnapshot('高优任务抢占，队列已重排');
      return;
    }

    this.appendOutput(`→ 执行准备：先由 ${this.deps.executor.name} 解析意图与构建上下文，随后按路由派发到具体 Executor`);
    this.appendTaskQueueSnapshot('任务开始执行');
  }

  private dispatchTask(taskId: string, context?: DispatchContext<QueuedExecutionRequest>): Promise<void> {
    const dispatchPromise = (async () => {
      const request = context?.executionRequest ?? this.buildFallbackExecutionRequest(taskId, context);
      if (!request) {
        this.appendOutput(`错误：任务 #${taskId} 缺少执行请求，无法派发`);
        return;
      }

      if (context?.missingExecutionRequest ?? true) {
        this.appendOutput(`→ 任务 #${taskId} 缺少待执行上下文，已根据持久化任务信息重建执行请求`);
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
      this.notify();
    });

    return dispatchPromise;
  }

  private buildFallbackExecutionRequest(taskId: string, context?: DispatchContext<QueuedExecutionRequest>): QueuedExecutionRequest | null {
    const task = this.taskRuntimeService.findTask(taskId);
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
    const task = this.taskRuntimeService.findTask(taskId);
    if (!task) {
      this.appendOutput(`错误：任务不存在 ${taskId}`);
      return;
    }

    this.maybeAppendExecutionGuidance(task, request);

    const approvedRecallSelection = this.approvedRecallSelections.get(taskId) ?? null;
    this.approvedRecallSelections.delete(taskId);
    await this.sessionExecutionCoordinator.execute({
      taskId,
      request,
      approvedRecallSelection,
    });
  }

  private setFocusContext(focus: FocusContext | null): void {
    this.taskRuntimeService.setFocusContext(focus);
    if (focus?.kind === 'task' && focus.taskId) {
      this.persistSessionState({ lastFocusedTaskId: focus.taskId });
    }
  }

  private getFocusContext(): FocusContext | null {
    return this.taskRuntimeService.getFocusContext();
  }

  private recoverOrphanedRunningTasks(): Task[] {
    const runningTasks = this.taskRuntimeService.listTasksByStatus('running');
    const recovered: Task[] = [];

    for (const task of runningTasks) {
      const interruptionReason = 'Metaclaw 重启，原执行器会话已断开';
      this.taskRuntimeService.parkTask(task.id, interruptionReason, {
        done: task.summary ? [task.summary] : [],
        pending: [task.goal],
        nextStep: '确认环境后恢复当前任务',
        pauseReason: interruptionReason,
      });
      this.taskRuntimeService.updateTask(task.id, {
        lastInterruptionReason: interruptionReason,
        interruptionCount: task.interruptionCount + 1,
      });
      const parkedTask = this.taskRuntimeService.findTask(task.id);
      if (parkedTask) {
        recovered.push(parkedTask);
      }
    }

    return recovered;
  }

  private resumeUnfinishedTasksOnStartup(recoveredRunningTasks: Task[]): void {
    const candidates = this.buildStartupResumeCandidates(recoveredRunningTasks);
    if (candidates.length === 0) {
      return;
    }

    this.trackBackgroundWork((async () => {
      const task = candidates[0];
      this.appendStartupResumeLine(task.id);
      if (task.status === 'parked') {
        await this.taskSemanticService.observeResumeIntent(
          '启动后继续未完成任务',
          this.buildRecentTaskSummaries([task]),
        );
        this.resumeParkedTaskIfStillParked(task.id);
      }
      await this.prepareTaskExecution(task.id, {
        userPrompt: task.goal,
        contextTaskId: task.id,
        executionMode: task.snapshots.length > 0 || task.lastInterruptionReason ? 'resume-parked' : 'fresh',
        origin: 'system',
        schedulingReason: '启动后恢复未完成任务',
      });
    })().finally(() => {
      this.notify();
    }));
  }

  private trackBackgroundWork(work: Promise<void>): void {
    this.backgroundWork.add(work);
    void work.finally(() => {
      this.backgroundWork.delete(work);
    });
  }

  private resumeParkedTaskIfStillParked(taskId: string): void {
    const latestTask = this.taskRuntimeService.findTask(taskId);
    if (latestTask?.status === 'parked') {
      this.taskRuntimeService.resumeParkedTask(taskId);
    }
  }

  private buildStartupResumeCandidates(recoveredRunningTasks: Task[]): Task[] {
    const byId = new Map<string, Task>();

    for (const task of recoveredRunningTasks) {
      byId.set(task.id, task);
    }

    for (const task of filterDurableTasks(this.taskRuntimeService.listTasks())) {
      if (['created', 'ready'].includes(task.status) && !byId.has(task.id)) {
        byId.set(task.id, task);
      }
      if (
        task.status === 'parked'
        && task.prioritySignals.isReady
        && task.dependencies.every(dependency => dependency.status === 'resolved')
        && !byId.has(task.id)
      ) {
        byId.set(task.id, task);
      }
    }

    const recoveredIds = new Set(recoveredRunningTasks.map(task => task.id));
    return Array.from(byId.values()).sort((left, right) => {
      const leftRecovered = recoveredIds.has(left.id);
      const rightRecovered = recoveredIds.has(right.id);
      if (leftRecovered !== rightRecovered) {
        return leftRecovered ? -1 : 1;
      }

      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }

  private appendStartupResumeLine(taskId: string): void {
    const task = this.taskRuntimeService.findTask(taskId);
    if (!task) {
      return;
    }

    this.appendOutput(
      task.snapshots.length > 0 || task.lastInterruptionReason
        ? `→ 启动后继续未完成任务 #${task.id}`
        : `→ 启动后恢复待执行任务 #${task.id}`,
    );
  }
}

export function createDefaultCommandRouter(): CommandRouter {
  const router = new CommandRouter();
  router.register(tasksCommand);
  router.register(taskCommand);
  router.register(memoryCommand);
  router.register(profileCommand);
  router.register(executorCommand);
  router.register(learningCommand);
  router.register(dashboardCommand);
  router.register(attachCommand);
  router.register(historyCommand);
  router.register(configCommand);
  router.register(helpCommand);
  router.register(exitCommand);
  return router;
}
