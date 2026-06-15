import type Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { MemoryApplicabilityAction } from '../core/types.js';
import type {
  Config,
  ExecutorResult,
  GuidanceActionType,
  GuidanceProposal,
  PreferenceMemoryCandidate,
  ResolvedPreference,
  RuntimeState,
  Task,
  TaskMemoryCandidate,
} from '../core/types.js';
import type { TaskEngine } from '../core/task-engine.js';
import type { MemoryEngine } from '../core/memory-engine.js';
import type { OrchestrationEngine } from '../core/orchestration.js';
import type { ExecutorAdapter, ExecutorInput, ExecutorProgressEvent } from '../executor/adapter.js';
import { createExecutorByName } from '../executor/factory.js';
import { CustomCliExecutorAdapter } from '../executor/custom-cli.js';
import { NoopNotificationService, type NotificationService } from '../notifications/types.js';
import type { ContextRecaller } from '../core/context-recaller.js';
import type { LlmBridge } from '../core/llm-bridge.js';
import { SchedulerEngine } from '../core/scheduler.js';
import type { DispatchContext } from '../core/scheduler.js';
import {
  classifyNaturalLanguageInput,
  fallbackTaskStateOwnership,
  filterDurableTasks,
  parseTaskClearInstruction,
  type TaskStatusQueryScope,
} from '../core/task-routing.js';
import { ResumeContextBuilder } from '../core/resume-context-builder.js';
import { RecallPolicyService } from '../core/recall-policy-service.js';
import { CommandRouter } from '../commands/router.js';
import { cancelTasksByScope, formatTaskClearResult, tasksCommand, taskCommand } from '../commands/task-commands.js';
import { memoryCommand } from '../commands/memory-commands.js';
import { profileCommand } from '../commands/profile-commands.js';
import { executorCommand } from '../commands/executor-commands.js';
import { learningCommand } from '../commands/learning-commands.js';
import { dashboardCommand, attachCommand, historyCommand, configCommand, helpCommand, exitCommand } from '../commands/global-commands.js';
import { generateInteractionId } from '../utils/id.js';
import { isPermissionFailure, isRecoverableExecutorFailure } from '../executor/error-utils.js';
import { RecallReviewPolicyRepo } from '../storage/recall-review-policy-repo.js';
import { MemoryAuditEventRepo } from '../storage/memory-audit-event-repo.js';
import { SessionStateRepo } from '../storage/session-state-repo.js';
import { SkillUsageEventRepo } from '../storage/skill-usage-event-repo.js';
import { ExecutorProfileRepo } from '../storage/executor-profile-repo.js';
import { ExecutorRouteEventRepo } from '../storage/executor-route-event-repo.js';
import { parseSkillUsageEventLine } from '../executor/skill-usage-event-parser.js';
import { ExecutorRouter, type ExecutorRouteDecision } from '../core/executor-router.js';
import { seedDefaultExecutorProfiles } from '../core/executor-registry-seeder.js';
import { reconcileBlockedTasksFromInput } from '../core/blocked-task-reconciler.js';
import {
  buildSchedulingReason,
  extractPatterns,
  isContinuePreviousTaskInstruction,
  isConversationDerivedWorkInstruction,
  isConversationalContinuationInstruction,
  isExplicitTaskControlReference,
  isHighRiskMemoryCandidate,
  isRiskCancellationInstruction,
  isRiskConfirmationInstruction,
  isRiskyExternalActionInstruction,
  isRecoverableBlockedResumeInstruction,
  isResumeReferenceInstruction,
  parseExplicitRemember,
  parsePriorityHint,
  planTaskExecution,
  extractInlineResourceMatches,
  extractHighConfidencePreferenceCandidates,
  stripInlineResourceMatches,
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

export interface GuidanceState {
  scene: string;
  taskId: string;
  taskTitle: string;
  recommendedAction: string;
  reasons: string[];
}

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

interface PendingRiskConfirmation {
  prompt: string;
}

interface PendingPreferenceConfirmation {
  observationId: string;
  pattern: string;
}

interface PendingProposalConfirmation {
  scene: string;
  proposal: GuidanceProposal;
}

interface PendingLastTaskConfirmation {
  originalInput: string;
  completedTaskId: string;
  unfinishedTaskId: string | null;
}

interface PendingRecallSelection {
  authoritative: boolean;
  resolvedPreferences: ResolvedPreference[];
  relatedTaskIds: string[];
  acceptedMemoryResources: string[];
}

interface RoutedExecutorSelection {
  executor: ExecutorAdapter;
  raceExecutors: ExecutorAdapter[];
  decision: ExecutorRouteDecision;
  eventId: string;
  effectiveAction: ExecutorRouteDecision['action'];
  fallbackReason: string | null;
}

interface ExecutorRaceResult {
  executor: ExecutorAdapter;
  result: ExecutorResult;
  abortedExecutors: string[];
}

interface PendingRecallReview {
  taskId: string;
  taskTitle: string;
  request: QueuedExecutionRequest;
  autoAppliedPreferenceCandidates: PreferenceMemoryCandidate[];
  autoAppliedTaskCandidates: TaskMemoryCandidate[];
  preferenceCandidates: PreferenceMemoryCandidate[];
  taskCandidates: TaskMemoryCandidate[];
  selectionItems: Array<
    | { kind: 'preference'; candidate: PreferenceMemoryCandidate }
    | { kind: 'task'; candidate: TaskMemoryCandidate }
  >;
}

type ExecutorRegisterWizardStep =
  | 'name'
  | 'mode'
  | 'projectUrl'
  | 'command'
  | 'args'
  | 'check'
  | 'domains'
  | 'capabilities'
  | 'confirm';

interface PendingExecutorRegisterWizard {
  step: ExecutorRegisterWizardStep;
  profile: {
    name?: string;
    projectUrl?: string | null;
    runtimeCommand?: string;
    runtimeArgs?: string[];
    runtimeCheckCommand?: string | null;
    domains?: string[];
    capabilities?: string[];
  };
}

const BUSY_LLM_TIMEOUT_MS = 250;
const DEFAULT_LLM_TIMEOUT_MS = 5_000;
const TASK_QUEUE_SNAPSHOT_LIMIT = 5;

function splitCommaList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

export class MetaclawSession {
  private output: string[] = [];
  private currentTaskId: string | null = null;
  private focusContext: FocusContext | null = null;
  private runtimeState: RuntimeState = {
    runningTaskId: null,
    runningExecutorName: null,
    readyTaskIds: [],
    blockedTaskIds: [],
    parkedTaskIds: [],
    lastEvent: null,
  };
  private latestGuidance: GuidanceState | null = null;
  private pendingRiskConfirmation: PendingRiskConfirmation | null = null;
  private pendingPreferenceConfirmation: PendingPreferenceConfirmation | null = null;
  private pendingProposalConfirmation: PendingProposalConfirmation | null = null;
  private pendingLastTaskConfirmation: PendingLastTaskConfirmation | null = null;
  private pendingRecallReview: PendingRecallReview | null = null;
  private pendingExecutorRegisterWizard: PendingExecutorRegisterWizard | null = null;
  private approvedRecallSelections = new Map<string, PendingRecallSelection>();
  private initialized = false;
  private listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private queuedExecution = new Map<string, QueuedExecutionRequest>();
  private activeDispatches = new Set<Promise<void>>();
  private lastProgressLineByTask = new Map<string, string>();
  private runningExecutorNameByTask = new Map<string, string>();
  private lastReminderAt: number | null = null;
  private lastReminderFingerprint: string | null = null;
  private lastTaskPoolWatchdogReminderAt: number | null = null;
  private lastTaskPoolWatchdogFingerprint: string | null = null;
  private lastBlockedRecheckAt: number | null = null;
  private blockedRecheckInFlight = false;
  private readonly resumeContextBuilder: ResumeContextBuilder;
  private readonly router: CommandRouter;
  private readonly scheduler: SchedulerEngine;
  private readonly sessionStateRepo: SessionStateRepo;
  private readonly notifier: NotificationService;

  constructor(private deps: MetaclawSessionDeps) {
    this.notifier = deps.notifier ?? new NoopNotificationService();
    this.sessionStateRepo = new SessionStateRepo(deps.db);
    this.resumeContextBuilder = new ResumeContextBuilder(
      deps.taskEngine,
      deps.memoryEngine,
      deps.contextRecaller,
    );
    this.router = createDefaultCommandRouter();
    this.scheduler = new SchedulerEngine(
      deps.taskEngine,
      deps.orchestration,
      deps.executor,
      async (taskId: string, context?: DispatchContext) => this.dispatchTask(taskId, context),
      async (tasks: Task[]) => this.classifyMissingSemanticPriorities(tasks),
    );
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
      currentTaskId: this.currentTaskId,
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

    const task = this.deps.taskEngine['taskRepo'].findById(this.latestGuidance.taskId);
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
        this.appendGuidanceBlock('启动建议', {
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
    const userInput = rawInput.trim();
    if (!userInput) {
      return { exitRequested: false };
    }

    this.appendOutput('', `> ${userInput}`);

    try {
      if (this.pendingExecutorRegisterWizard && !userInput.startsWith('/')) {
        await this.handlePendingExecutorRegisterWizard(userInput);
        return { exitRequested: false };
      }

      if (userInput.startsWith('/')) {
        const exitRequested = await this.handleCommand(userInput);
        if (options.awaitAsyncWork) {
          await this.waitForAsyncWork();
        }
        return { exitRequested };
      }

      await this.handleNaturalLanguageInput(userInput);
      if (options.awaitAsyncWork) {
        await this.waitForAsyncWork();
      }
      return { exitRequested: false };
    } catch (error) {
      this.appendOutput(`错误: ${(error as Error).message}`);
      if (options.awaitAsyncWork) {
        await this.waitForAsyncWork();
      }
      return { exitRequested: false };
    }
  }

  async waitForAsyncWork(): Promise<void> {
    while (this.activeDispatches.size > 0) {
      await Promise.allSettled(Array.from(this.activeDispatches));
    }
  }

  appendSystemMessage(...lines: string[]): void {
    this.appendOutput(...lines);
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
      this.deps.taskEngine.unblock(target.id);
      this.setCurrentTaskId(target.id);
      this.setFocusContext({ kind: 'task', taskId: target.id });
      this.appendOutput(
        `→ 定时检查：任务 #${target.id} 的阻塞条件可能已恢复`,
        `→ 原阻塞原因：${this.getWaitingBlockReason(target) || '未知原因'}`,
        '→ 已解除阻塞并重新进入调度',
      );
      await this.prepareTaskExecution(target.id, {
        userPrompt: target.goal,
        contextTaskId: target.id,
        executionMode: 'resume-blocked',
        schedulingReason: '定时检查确认执行器可用，恢复阻塞任务',
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
      const task = this.deps.taskEngine['taskRepo'].findById(scheduledTaskId);
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
    return filterDurableTasks(this.deps.taskEngine.list())
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

  private maybeEmitTaskPoolWatchdogReminder(nowMs: number): boolean {
    if (!this.deps.config.orchestration.reminder_enabled) {
      return false;
    }

    const blockedTasks = filterDurableTasks(this.deps.taskEngine.list())
      .filter(task => task.status === 'blocked');
    const parkedTasks = filterDurableTasks(this.deps.taskEngine.list())
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
    this.appendOutput(...this.formatTaskPoolWatchdogReminder(blockedTasks, parkedTasks));
    return true;
  }

  private formatTaskPoolWatchdogReminder(blockedTasks: Task[], parkedTasks: Task[]): string[] {
    const lines = [
      '',
      '┌─ 任务池看护提醒 ─────────────────────────────────┐',
      `│ 当前不可自动执行：阻塞 ${blockedTasks.length} / 挂起 ${parkedTasks.length}`,
    ];

    if (blockedTasks.length > 0) {
      lines.push('│ 阻塞任务：');
      for (const task of blockedTasks.slice(0, TASK_QUEUE_SNAPSHOT_LIMIT)) {
        const reason = this.getWaitingBlockReason(task) || '等待解除阻塞';
        lines.push(`│   #${task.id} ${task.title}`);
        lines.push(`│     原因：${reason}`);
        lines.push(`│     还差：${this.describeBlockedTaskMissingCondition(reason, task.id)}`);
      }
      if (blockedTasks.length > TASK_QUEUE_SNAPSHOT_LIMIT) {
        lines.push(`│   ... 还有 ${blockedTasks.length - TASK_QUEUE_SNAPSHOT_LIMIT} 个阻塞任务`);
      }
    }

    if (parkedTasks.length > 0) {
      lines.push('│ 挂起任务：');
      for (const task of parkedTasks.slice(0, TASK_QUEUE_SNAPSHOT_LIMIT)) {
        const latestSnapshot = task.snapshots.at(-1);
        lines.push(`│   #${task.id} ${task.title}`);
        lines.push(`│     原因：${task.lastInterruptionReason || latestSnapshot?.pauseReason || '等待恢复'}`);
        lines.push(`│     下一步：${latestSnapshot?.nextStep || '继续推进当前任务'}`);
      }
      if (parkedTasks.length > TASK_QUEUE_SNAPSHOT_LIMIT) {
        lines.push(`│   ... 还有 ${parkedTasks.length - TASK_QUEUE_SNAPSHOT_LIMIT} 个挂起任务`);
      }
    }

    lines.push('└──────────────────────────────────────────────────┘');
    return lines;
  }

  private describeBlockedTaskMissingCondition(reason: string, taskId: string): string {
    if (/材料|文件|链接|文档|资料|补充|缺少|等待/i.test(reason)) {
      return `补充材料/文件/链接后，我会自动恢复；也可执行 /task ${taskId} unblock [材料路径]`;
    }

    if (/授权|权限|permission|authorized|access/i.test(reason)) {
      return `确认权限/授权后，直接说“已授权，继续任务 ${taskId}”或执行 /task ${taskId} unblock`;
    }

    if (isRecoverableExecutorFailure(reason)) {
      return '等待执行器或网络恢复；定时检查会自动重试';
    }

    return `确认阻塞条件已解除后执行 /task ${taskId} unblock`;
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach(listener => listener(snapshot));
  }

  private buildSuggestionTaskTitleSuffix(taskId: string): string {
    const task = this.deps.taskEngine['taskRepo'].findById(taskId);
    if (!task?.title) {
      return '';
    }

    return ` ${task.title}`;
  }

  private setLatestGuidance(
    scene: string,
    suggestion: { taskId: string; recommendedAction: string; reasons: string[] },
  ): void {
    this.latestGuidance = {
      scene,
      taskId: suggestion.taskId,
      taskTitle: this.deps.taskEngine['taskRepo'].findById(suggestion.taskId)?.title ?? '',
      recommendedAction: suggestion.recommendedAction,
      reasons: [...suggestion.reasons],
    };
  }

  private appendGuidanceBlock(
    scene: string,
    suggestion: { taskId: string; recommendedAction: string; reasons: string[] },
  ): void {
    this.setLatestGuidance(scene, suggestion);
    const taskTitle = this.latestGuidance?.taskTitle ?? '';
    const titleSuffix = taskTitle ? ` ${taskTitle}` : '';
    const lines = [
      '',
      '┌─ 操作指引 ───────────────────────────────────────┐',
      `│ 场景：${scene}`,
      `│ 推荐动作：${suggestion.recommendedAction}`,
      `│ 目标任务：#${suggestion.taskId}${titleSuffix}`,
    ];

    if (suggestion.reasons.length === 0) {
      lines.push('│ 原因：上下文已准备完成，可继续执行');
    } else {
      suggestion.reasons.forEach((reason, index) => {
        lines.push(`${index === 0 ? '│ 原因：' : '│       '}${reason}`);
      });
    }

    lines.push('└──────────────────────────────────────────────────┘');
    this.appendOutput(...lines);
  }

  private appendProposalBlock(scene: string, proposal: GuidanceProposal): void {
    const taskTitle = proposal.taskId
      ? this.deps.taskEngine['taskRepo'].findById(proposal.taskId)?.title ?? ''
      : '';

    this.appendOutput(
      '',
      '┌─ 操作提案 ───────────────────────────────────────┐',
      `│ 场景：${scene}`,
      `│ 动作：${proposal.recommendedAction}`,
      proposal.taskId ? `│ 目标任务：#${proposal.taskId}${taskTitle ? ` ${taskTitle}` : ''}` : '│ 目标任务：无',
      ...proposal.reasons.map((reason, index) => `${index === 0 ? '│ 理由：' : '│       '}${reason}`),
      `│ 置信度：${proposal.confidence.toFixed(2)}`,
      '│ 策略：无需用户确认；高置信提案自动执行，低置信提案自动跳过',
      '└──────────────────────────────────────────────────┘',
    );
  }

  private appendRecallReviewBlock(review: PendingRecallReview): void {
    const lines = [
      '',
      '┌─ 记忆召回自动处理 ───────────────────────────────┐',
      `│ 当前任务：#${review.taskId} ${review.taskTitle}`,
      '│ 策略：无需用户确认；明确适用的记忆自动采用，不确定的记忆默认跳过',
    ];

    if (review.selectionItems.length === 0) {
      lines.push('│ 没有待处理的召回项，将直接继续执行');
    } else {
      review.selectionItems.forEach((item, index) => {
        const label = item.kind === 'preference'
          ? `[${item.candidate.scope}] ${item.candidate.summary}`
          : `${item.candidate.title}: ${item.candidate.summary}`;
        lines.push(`│ ${index + 1}. ${label}`);
        lines.push(`│    判断依据：${item.kind === 'preference' ? item.candidate.reason : item.candidate.reason}`);
      });
    }

    lines.push(
      '│ 当前通道不等待人工选择；如果需要调整长期偏好，可稍后使用 /memory 管理',
      '└──────────────────────────────────────────────────┘',
    );

    this.appendOutput(...lines);
  }

  private appendLastTaskAutoDecisionBlock(pending: PendingLastTaskConfirmation, decision: 'resume-unfinished' | 'follow-up'): void {
    const completedTask = this.deps.taskEngine['taskRepo'].findById(pending.completedTaskId);
    if (!completedTask) {
      return;
    }

    const unfinishedTask = pending.unfinishedTaskId
      ? this.deps.taskEngine['taskRepo'].findById(pending.unfinishedTaskId)
      : null;

    const lines = [
      '',
      '┌─ 上次任务自动处理 ───────────────────────────────┐',
      `│ 上一个任务：#${completedTask.id} ${completedTask.title}`,
      '│ 上一个任务已完成。',
      decision === 'resume-unfinished' && unfinishedTask
        ? `│ 自动决策：恢复最近未完成任务 #${unfinishedTask.id} ${unfinishedTask.title}`
        : '│ 自动决策：基于上一个任务创建 follow-up',
      '│ 策略：无需用户确认；优先恢复未完成任务，否则创建跟进任务',
      '└──────────────────────────────────────────────────┘',
    ];

    this.appendOutput(...lines);
  }

  private queueProposal(scene: string, proposal: GuidanceProposal): void {
    if (this.pendingProposalConfirmation || this.pendingRecallReview) {
      return;
    }

    this.appendProposalBlock(scene, proposal);
    this.appendOutput('→ 操作提案已记录，不等待用户确认；满足执行条件的任务由调度器自动处理');
  }

  private createRecallPolicyService(): RecallPolicyService {
    return new RecallPolicyService(new RecallReviewPolicyRepo(this.deps.db));
  }

  private seedExecutorRegistry(): void {
    seedDefaultExecutorProfiles(new ExecutorProfileRepo(this.deps.db), {
      defaultExecutorName: this.deps.executor.name,
      availableCommands: this.deps.availableExecutorCommands,
    });
  }

  private resolveExecutorForTask(taskId: string | null, userInput: string): RoutedExecutorSelection {
    this.seedExecutorRegistry();
    const defaultExecutorName = this.deps.executor.name;
    const profiles = new ExecutorProfileRepo(this.deps.db).findAll();
    const decision = new ExecutorRouter(profiles).route({ userInput, defaultExecutorName });
    const routeEventRepo = new ExecutorRouteEventRepo(this.deps.db);
    const eventId = `route_${generateInteractionId()}`;
    routeEventRepo.insert({
      id: eventId,
      taskId,
      userInput,
      selectedExecutor: decision.selectedExecutor,
      action: decision.action,
      candidates: decision.candidates,
      primaryIntent: decision.primaryIntent,
      matchedBoundary: decision.matchedBoundary,
      rejected: decision.rejected,
      reason: decision.reason,
      confirmedByUser: false,
      result: null,
      createdAt: new Date().toISOString(),
    });

    const selectedExecutor = decision.selectedExecutor === defaultExecutorName
      ? this.deps.executor
      : this.createExecutorForRoute(decision.selectedExecutor);
    if (!selectedExecutor) {
      routeEventRepo.updateResult(eventId, 'fallback_default:unsupported_executor');
      return {
        executor: this.deps.executor,
        raceExecutors: [this.deps.executor],
        decision,
        eventId,
        effectiveAction: 'fallback_default',
        fallbackReason: `Executor ${decision.selectedExecutor} 已注册但当前运行时无法直接派发，回退 ${defaultExecutorName}`,
      };
    }

    const raceExecutors = this.resolveRaceExecutors(decision, selectedExecutor, defaultExecutorName, profiles);
    return {
      executor: selectedExecutor,
      raceExecutors,
      decision,
      eventId,
      effectiveAction: decision.action,
      fallbackReason: null,
    };
  }

  private resolveRaceExecutors(
    decision: ExecutorRouteDecision,
    selectedExecutor: ExecutorAdapter,
    defaultExecutorName: string,
    profiles: import('../core/executor-router.js').ExecutorProfile[],
  ): ExecutorAdapter[] {
    if (
      decision.action !== 'auto_dispatch'
      || !this.shouldRaceResearchExecutors(decision)
    ) {
      return [selectedExecutor];
    }

    const availableResearchExecutors = new Set<string>(
      profiles
        .filter(profile => profile.availability === 'available')
        .map(profile => profile.name)
        .filter(name => name === 'pi-agent' || name === 'hermes-agent'),
    );

    const candidates = ['pi-agent', 'hermes-agent']
      .filter(name => availableResearchExecutors.has(name))
      .map(name => this.resolveExecutorAdapterByName(name, defaultExecutorName))
      .filter((executor): executor is ExecutorAdapter => Boolean(executor));
    const byName = new Map<string, ExecutorAdapter>();
    for (const executor of [...candidates, selectedExecutor]) {
      byName.set(executor.name, executor);
    }
    return Array.from(byName.values());
  }

  private shouldRaceResearchExecutors(decision: ExecutorRouteDecision): boolean {
    if (decision.primaryIntent === 'research_workflow') {
      return true;
    }

    return decision.primaryIntent === 'memory_agent_ops'
      && decision.matchedBoundary.some(boundary => [
        'research',
        'multi_tool',
        'workflow_automation',
        'skill_runtime',
        'mcp',
        'report_generation',
        'messaging_gateway',
      ].includes(boundary));
  }

  private resolveExecutorAdapterByName(name: string, defaultExecutorName: string): ExecutorAdapter | null {
    if (name === defaultExecutorName) {
      return this.deps.executor;
    }
    return this.createExecutorForRoute(name);
  }

  private createExecutorForRoute(name: string): ExecutorAdapter | null {
    const injected = this.deps.executorFactory?.(name);
    if (injected) {
      return injected;
    }

    const customProfile = new ExecutorProfileRepo(this.deps.db).findByName(name);
    if (customProfile?.runtimeCommand) {
      return new CustomCliExecutorAdapter({
        name,
        command: customProfile.runtimeCommand,
        args: customProfile.runtimeArgs ?? [],
        checkCommand: customProfile.runtimeCheckCommand,
        timeout: this.deps.config.executor.timeout,
        maxDuration: this.deps.config.executor.max_duration,
        workspaceRoot: process.cwd(),
      });
    }

    return createExecutorByName(name, {
      timeout: this.deps.config.executor.timeout,
      maxDuration: this.deps.config.executor.max_duration,
      workspaceRoot: process.cwd(),
    });
  }

  private formatExecutorRunLabel(executors: ExecutorAdapter[]): string {
    return executors.map(executor => executor.name).join('+');
  }

  private async ensureRoutedExecutorAvailability(routedExecutor: RoutedExecutorSelection): Promise<RoutedExecutorSelection> {
    if (
      routedExecutor.executor.name === this.deps.executor.name
      || routedExecutor.raceExecutors.length > 1
    ) {
      return routedExecutor;
    }

    const profileRepo = new ExecutorProfileRepo(this.deps.db);
    const profile = profileRepo.findByName(routedExecutor.executor.name);
    if (!profile?.runtimeCommand) {
      return routedExecutor;
    }

    const available = await routedExecutor.executor.isAvailable();
    if (available) {
      return routedExecutor;
    }

    profileRepo.upsert({
      ...profile,
      availability: 'unavailable',
    });
    new ExecutorRouteEventRepo(this.deps.db).updateResult(routedExecutor.eventId, 'fallback_default:executor_unavailable');

    return {
      ...routedExecutor,
      executor: this.deps.executor,
      raceExecutors: [this.deps.executor],
      effectiveAction: 'fallback_default',
      fallbackReason: `Executor ${routedExecutor.executor.name} 已注册但安装检测失败，已标记 unavailable 并回退 ${this.deps.executor.name}`,
    };
  }

  private appendExecutorRoutingDecision(routedExecutor: RoutedExecutorSelection): void {
    const reason = `${routedExecutor.decision.primaryIntent} / ${routedExecutor.decision.matchedBoundary.join(' + ') || routedExecutor.decision.reason}`;
    if (routedExecutor.raceExecutors.length > 1) {
      this.appendOutput(
        `→ 路由决策：调研竞速 (${routedExecutor.effectiveAction}, confidence=${routedExecutor.decision.confidence.toFixed(2)})`,
        `→ 执行器：${routedExecutor.raceExecutors.map(executor => executor.name).join(' + ')}`,
        `→ 原始首选：${routedExecutor.decision.selectedExecutor}；原因：${reason}`,
      );
      return;
    }

    this.appendOutput(
      `→ 路由决策：${routedExecutor.decision.selectedExecutor} (${routedExecutor.effectiveAction}, confidence=${routedExecutor.decision.confidence.toFixed(2)})`,
      `→ 原因：${reason}`,
    );
  }

  private async executeWithOptionalRace(
    executors: ExecutorAdapter[],
    input: Omit<ExecutorInput, 'onProgress'> & {
      onProgress: (event: ExecutorProgressEvent, executor: ExecutorAdapter) => void;
    },
  ): Promise<ExecutorRaceResult> {
    if (executors.length <= 1) {
      const executor = executors[0] ?? this.deps.executor;
      return {
        executor,
        result: await executor.execute({
          ...input,
          onProgress: event => input.onProgress(event, executor),
        }),
        abortedExecutors: [],
      };
    }

    let settled = false;
    const running = new Set(executors);
    return new Promise<ExecutorRaceResult>((resolve) => {
      for (const executor of executors) {
        executor.execute({
          ...input,
          onProgress: event => input.onProgress(event, executor),
        }).then((result) => {
          running.delete(executor);
          if (settled) {
            return;
          }

          settled = true;
          const abortedExecutors = Array.from(running)
            .filter(other => other !== executor)
            .map(other => {
              other.abort();
              return other.name;
            });
          resolve({ executor, result, abortedExecutors });
        }).catch((error: Error) => {
          running.delete(executor);
          if (settled) {
            return;
          }

          settled = true;
          const abortedExecutors = Array.from(running)
            .filter(other => other !== executor)
            .map(other => {
              other.abort();
              return other.name;
            });
          resolve({
            executor,
            result: {
              success: false,
              output: '',
              error: error.message,
              exitCode: 1,
              durationMs: 0,
            },
            abortedExecutors,
          });
        });
      }
    });
  }

  private async executeCodexFallbackOnFailure(input: {
    taskId: string;
    failedExecutor: ExecutorAdapter;
    failedResult: ExecutorResult;
    input: Omit<ExecutorInput, 'onProgress'>;
    onProgress: (event: ExecutorProgressEvent, executor: ExecutorAdapter) => void;
  }): Promise<ExecutorRaceResult | null> {
    if (input.failedExecutor.name === 'codex-cli') {
      return null;
    }

    const currentTask = this.deps.taskEngine['taskRepo'].findById(input.taskId);
    if (!currentTask || currentTask.status !== 'running') {
      return null;
    }

    const codexExecutor = this.resolveExecutorAdapterByName('codex-cli', this.deps.executor.name);
    if (!codexExecutor) {
      this.appendOutput(
        `→ ${input.failedExecutor.name} 执行失败: ${input.failedResult.error || '未知错误'}`,
        '→ codex-cli 兜底执行器不可用，按原失败结果处理',
      );
      return null;
    }

    this.runningExecutorNameByTask.set(input.taskId, codexExecutor.name);
    this.refreshRuntimeState();
    this.appendOutput(
      `→ ${input.failedExecutor.name} 执行失败: ${input.failedResult.error || '未知错误'}`,
      '→ 改派给 codex-cli 兜底执行同一任务，不新建任务',
    );

    try {
      const result = await codexExecutor.execute({
        ...input.input,
        task: this.deps.taskEngine['taskRepo'].findById(input.taskId) ?? input.input.task,
        onProgress: event => input.onProgress(event, codexExecutor),
      });
      return { executor: codexExecutor, result, abortedExecutors: [] };
    } catch (error) {
      return {
        executor: codexExecutor,
        result: {
          success: false,
          output: '',
          error: (error as Error).message,
          exitCode: 1,
          durationMs: 0,
        },
        abortedExecutors: [],
      };
    }
  }

  private async prepareTaskExecution(
    taskId: string,
    request: QueuedExecutionRequest,
    proposalType: GuidanceActionType | null = null,
  ): Promise<void> {
    const task = this.deps.taskEngine['taskRepo'].findById(taskId);
    if (!task) {
      this.appendOutput(`错误：任务不存在 ${taskId}`);
      return;
    }

    const recallResult = await this.deps.memoryEngine.recallForReview({
      taskId,
      keywords: this.extractRecallKeywords(request.userPrompt),
      userInput: request.userPrompt,
    });

    const autoAppliedPreferenceCandidates = recallResult.preferenceCandidates.filter(candidate =>
      candidate.applicabilityAction === MemoryApplicabilityAction.AUTO_APPLY
    );
    const reviewPreferenceCandidates = recallResult.preferenceCandidates.filter(candidate =>
      candidate.applicabilityAction !== MemoryApplicabilityAction.AUTO_APPLY
    );
    const autoAppliedTaskCandidates: TaskMemoryCandidate[] = [];
    const reviewTaskCandidates = recallResult.taskCandidates;

    const decision = this.createRecallPolicyService().resolve({
      proposalType,
      taskCandidates: reviewTaskCandidates,
      preferenceCandidates: reviewPreferenceCandidates,
    });
    const policyApplied = !decision.requiresReview || proposalType !== null;
    const acceptedPreferenceCandidates = policyApplied
      ? [...autoAppliedPreferenceCandidates, ...reviewPreferenceCandidates]
      : autoAppliedPreferenceCandidates;
    const acceptedTaskCandidates = policyApplied
      ? [...autoAppliedTaskCandidates, ...reviewTaskCandidates]
      : autoAppliedTaskCandidates;

    this.approvedRecallSelections.set(
      taskId,
      this.buildAcceptedRecallSelection(acceptedPreferenceCandidates, acceptedTaskCandidates),
    );

    if (acceptedPreferenceCandidates.length > 0 || acceptedTaskCandidates.length > 0) {
      this.appendAutoAppliedMemoryBlock(
        taskId,
        task.title,
        acceptedPreferenceCandidates,
        acceptedTaskCandidates,
      );
    }

    const skippedPreferenceCandidates = policyApplied ? [] : reviewPreferenceCandidates;
    const skippedTaskCandidates = policyApplied ? [] : reviewTaskCandidates;
    if (skippedPreferenceCandidates.length > 0 || skippedTaskCandidates.length > 0) {
      this.recordSuppressedRecallMemoryAuditEvents(taskId, skippedPreferenceCandidates);
      this.appendSuppressedRecallBlock(taskId, task.title, skippedPreferenceCandidates, skippedTaskCandidates);
    }

    await this.submitScheduledTask(taskId, request);
  }

  private recordSuppressedRecallMemoryAuditEvents(taskId: string, preferenceCandidates: PreferenceMemoryCandidate[]): void {
    for (const candidate of preferenceCandidates) {
      this.recordMemoryAuditEvent({
        taskId,
        memoryId: candidate.preferenceId,
        action: 'suppress',
        score: candidate.applicabilityScore ?? Math.min(1, candidate.score / 100),
        reason: `不确定是否适用，默认不召回：${candidate.applicabilityReason ?? candidate.reason}`,
        judgeSource: candidate.judgeSource ?? 'rule',
        evidence: [{ reason: candidate.reason, source: candidate.source }],
      });
    }
  }

  private appendAutoAppliedMemoryBlock(
    taskId: string,
    taskTitle: string,
    preferenceCandidates: PreferenceMemoryCandidate[],
    taskCandidates: TaskMemoryCandidate[],
  ): void {
    const lines = [
      '',
      '┌─ 已自动采用记忆 ─────────────────────────────────┐',
      `│ 当前任务：#${taskId} ${taskTitle}`,
    ];

    for (const candidate of preferenceCandidates) {
      const score = candidate.applicabilityScore ?? Math.min(1, candidate.score / 100);
      const reason = candidate.applicabilityReason ?? candidate.reason;
      this.recordMemoryAuditEvent({
        taskId,
        memoryId: candidate.preferenceId,
        action: 'auto_apply',
        score,
        reason,
        judgeSource: candidate.judgeSource ?? 'rule',
        evidence: [{ reason: candidate.reason, source: candidate.source }],
      });
      lines.push(`│ - ${candidate.preferenceId}: ${candidate.summary} score=${score.toFixed(2)}`);
      lines.push(`│   reason=${reason}`);
    }

    for (const candidate of taskCandidates) {
      lines.push(`│ - ${candidate.id}: ${candidate.title} score=${candidate.score}`);
      lines.push(`│   reason=${candidate.reason}`);
    }

    lines.push('└──────────────────────────────────────────────────┘');
    this.appendOutput(...lines);
  }

  private appendSuppressedRecallBlock(
    taskId: string,
    taskTitle: string,
    preferenceCandidates: PreferenceMemoryCandidate[],
    taskCandidates: TaskMemoryCandidate[],
  ): void {
    this.appendOutput(
      '',
      '┌─ 已跳过不确定记忆 ───────────────────────────────┐',
      `│ 当前任务：#${taskId} ${taskTitle}`,
      '│ 策略：无需用户确认；无法确定适用的召回默认不注入执行上下文',
      `│ 跳过：${preferenceCandidates.length} 条偏好，${taskCandidates.length} 条任务记忆`,
      '└──────────────────────────────────────────────────┘',
    );
  }

  private buildAcceptedRecallSelection(
    preferenceCandidates: PreferenceMemoryCandidate[],
    taskCandidates: TaskMemoryCandidate[],
  ): PendingRecallSelection {
    return {
      authoritative: true,
      resolvedPreferences: preferenceCandidates.map(candidate => ({
        id: candidate.preferenceId,
        content: candidate.summary,
        scope: candidate.scope,
        confidence: Math.min(1, candidate.score / 100),
        reason: candidate.reason,
      })),
      relatedTaskIds: Array.from(new Set(taskCandidates.map(candidate => candidate.taskId))),
      acceptedMemoryResources: Array.from(new Set(
        taskCandidates.flatMap(candidate => candidate.artifactPaths),
      )),
    };
  }

  private buildRecallSelectionWithAutoApplied(
    pending: PendingRecallReview,
    preferenceCandidates: PreferenceMemoryCandidate[],
    taskCandidates: TaskMemoryCandidate[],
  ): PendingRecallSelection {
    return this.buildAcceptedRecallSelection(
      [...pending.autoAppliedPreferenceCandidates, ...preferenceCandidates],
      [...pending.autoAppliedTaskCandidates, ...taskCandidates],
    );
  }

  private parseRecallSelectionInput(input: string, maxIndex: number): number[] | null {
    const trimmed = input.trim();
    const selectMatch = trimmed.match(/^s(?:\s+(.+))$/iu);
    if (selectMatch) {
      return this.parseRecallIndexes(selectMatch[1] ?? '', maxIndex);
    }

    const quickPickMatch = trimmed.match(/^x\s*(\d+)$/iu);
    if (quickPickMatch) {
      return this.parseRecallIndexes(quickPickMatch[1] ?? '', maxIndex);
    }

    return null;
  }

  private parseRecallFeedbackInput(
    input: string,
    maxIndex: number,
  ): { action: 'irrelevant' | 'hide'; indexes: number[] } | null {
    const match = input.trim().match(/^(?:i|irrelevant|h|hide)(?:\s+(.+))$/iu);
    if (!match) {
      return null;
    }

    const command = input.trim().split(/\s+/u)[0]?.toLowerCase();
    const action = command === 'h' || command === 'hide' ? 'hide' : 'irrelevant';
    return {
      action,
      indexes: this.parseRecallIndexes(match[1] ?? '', maxIndex),
    };
  }

  private parseRecallIndexes(raw: string, maxIndex: number): number[] {
    const indexes = raw
      .split(/[\s,，]+/)
      .map(token => Number.parseInt(token, 10))
      .filter(index => Number.isInteger(index) && index >= 1 && index <= maxIndex);

    return Array.from(new Set(indexes));
  }

  private handlePendingProposalConfirmation(userInput: string): boolean {
    if (!this.pendingProposalConfirmation) {
      return false;
    }

    const trimmed = userInput.trim();
    const pending = this.pendingProposalConfirmation;

    if (/^r$/iu.test(trimmed)) {
      this.appendProposalBlock(pending.scene, pending.proposal);
      return true;
    }

    if (/^n$/iu.test(trimmed)) {
      this.pendingProposalConfirmation = null;
      this.appendOutput('→ 已忽略当前操作提案');
      return true;
    }

    if (/^y$/iu.test(trimmed)) {
      this.pendingProposalConfirmation = null;
      void this.acceptProposal(pending).catch(error => {
        this.appendOutput(`错误: ${(error as Error).message}`);
      });
      return true;
    }

    this.pendingProposalConfirmation = null;
    return false;
  }

  private async handlePendingLastTaskConfirmation(userInput: string): Promise<boolean> {
    if (!this.pendingLastTaskConfirmation) {
      return false;
    }

    const trimmed = userInput.trim();
    const pending = this.pendingLastTaskConfirmation;

    if (/^r$/iu.test(trimmed)) {
      this.appendLastTaskAutoDecisionBlock(pending, pending.unfinishedTaskId ? 'resume-unfinished' : 'follow-up');
      return true;
    }

    if (/^n$/iu.test(trimmed)) {
      this.pendingLastTaskConfirmation = null;
      this.appendOutput('→ 已取消本次跨会话自动关联');
      return true;
    }

    if (/^f$/iu.test(trimmed)) {
      this.pendingLastTaskConfirmation = null;
      try {
        await this.createFollowUpFromCompletedTask(pending);
      } catch (error) {
        this.appendOutput(`错误: ${(error as Error).message}`);
      }
      return true;
    }

    if (/^u$/iu.test(trimmed)) {
      if (!pending.unfinishedTaskId) {
        this.appendOutput('→ 当前没有可恢复的未完成任务，已保留自动 follow-up 策略。');
        return true;
      }

      this.pendingLastTaskConfirmation = null;
      try {
        await this.resumeUnfinishedTaskFromConfirmation(pending);
      } catch (error) {
        this.appendOutput(`错误: ${(error as Error).message}`);
      }
      return true;
    }

    this.appendOutput('→ 当前没有待确认步骤；上次任务处理已自动决策。');
    return true;
  }

  private async acceptProposal(pending: PendingProposalConfirmation): Promise<void> {
    const proposal = pending.proposal;
    if (!proposal.taskId) {
      this.appendOutput('错误：提案缺少目标任务');
      return;
    }

    const task = this.deps.taskEngine['taskRepo'].findById(proposal.taskId);
    if (!task) {
      this.appendOutput(`错误：任务不存在 ${proposal.taskId}`);
      return;
    }

    if (proposal.actionType === 'unblock_and_resume' && task.status === 'blocked') {
      this.deps.taskEngine.unblock(task.id);
    }

    const executionMode = task.status === 'parked'
      ? 'resume-parked'
      : proposal.actionType === 'unblock_and_resume'
        ? 'resume-blocked'
        : 'fresh';

    await this.prepareTaskExecution(task.id, {
      userPrompt: task.goal,
      contextTaskId: task.id,
      executionMode,
      schedulingReason: proposal.recommendedAction,
    }, proposal.actionType);
  }

  private async createFollowUpFromCompletedTask(pending: PendingLastTaskConfirmation): Promise<void> {
    const completedTask = this.deps.taskEngine['taskRepo'].findById(pending.completedTaskId);
    if (!completedTask) {
      this.appendOutput(`错误：任务不存在 ${pending.completedTaskId}`);
      return;
    }

    const followUpTask = this.deps.taskEngine.create({
      title: completedTask.title,
      goal: completedTask.goal,
      resources: completedTask.resources,
    });

    this.setCurrentTaskId(followUpTask.id);
    this.setFocusContext({ kind: 'task', taskId: followUpTask.id });
    this.appendOutput(
      `→ 基于上一个已完成任务 #${completedTask.id} 创建 follow-up 任务 #${followUpTask.id}`,
    );
    await this.prepareTaskExecution(followUpTask.id, {
      userPrompt: pending.originalInput,
      contextTaskId: completedTask.id,
      executionMode: 'follow-up',
      schedulingReason: '基于上次已完成任务继续',
    });
  }

  private async resumeUnfinishedTaskFromConfirmation(pending: PendingLastTaskConfirmation): Promise<void> {
    const unfinishedTask = pending.unfinishedTaskId
      ? this.deps.taskEngine['taskRepo'].findById(pending.unfinishedTaskId)
      : null;

    if (!unfinishedTask) {
      this.appendOutput('错误：未找到可恢复的未完成任务');
      return;
    }

    const plan = planTaskExecution(unfinishedTask, pending.originalInput);
    if (plan.mode === 'blocked') {
      this.appendOutput(`错误：${plan.error}`);
      return;
    }

    if (plan.mode === 'fork-follow-up') {
      this.appendOutput(`错误：最近未完成任务 #${unfinishedTask.id} 当前不可直接恢复`);
      return;
    }

    this.setCurrentTaskId(plan.executionTaskId);
    this.setFocusContext({ kind: 'task', taskId: plan.executionTaskId });
    this.appendOutput(`→ 改为恢复最近未完成任务 #${unfinishedTask.id}`);
    await this.prepareTaskExecution(plan.executionTaskId, {
      userPrompt: pending.originalInput,
      contextTaskId: plan.contextTaskId,
      executionMode: unfinishedTask.status === 'parked' ? 'resume-parked' : 'fresh',
      schedulingReason: unfinishedTask.status === 'parked' ? '恢复最近未完成任务' : '继续最近未完成任务',
    });
  }

  private handlePendingRecallReview(): boolean {
    if (!this.pendingRecallReview) {
      return false;
    }

    const pending = this.pendingRecallReview;
    this.pendingRecallReview = null;
    this.approvedRecallSelections.set(
      pending.taskId,
      this.buildAcceptedRecallSelection(
        pending.autoAppliedPreferenceCandidates,
        pending.autoAppliedTaskCandidates,
      ),
    );
    this.appendOutput('→ 已清理遗留记忆召回选择状态；当前通道不等待用户确认，不确定召回已默认跳过。');
    void this.submitScheduledTask(pending.taskId, pending.request);
    return true;
  }

  private extractRecallKeywords(userPrompt: string): string[] {
    return userPrompt.split(/[\s，。？！、；：""''（）\[\]{}]+/)
      .filter(Boolean)
      .filter(token => token.length >= 2)
      .slice(0, 12);
  }

  private maybeAppendExecutionGuidance(task: Task, request: QueuedExecutionRequest): void {
    if (request.executionMode === 'resume-blocked') {
      const reasons = ['阻塞已解除，任务重新具备执行条件'];
      if (request.newlyProvidedResources && request.newlyProvidedResources.length > 0) {
        reasons.push(`已补充 ${request.newlyProvidedResources.length} 份新材料`);
      }

      this.appendGuidanceBlock('解除阻塞后恢复', {
        taskId: task.id,
        recommendedAction: `继续处理任务 #${task.id}: ${task.title}`,
        reasons,
      });
      return;
    }

    if (request.executionMode === 'resume-parked') {
      this.appendGuidanceBlock('恢复已挂起任务', {
        taskId: task.id,
        recommendedAction: `继续处理任务 #${task.id}: ${task.title}`,
        reasons: this.buildResumeGuidanceReasons(task),
      });
    }
  }

  private buildResumeGuidanceReasons(task: Task): string[] {
    const reasons: string[] = [];
    const latestSnapshot = task.snapshots[task.snapshots.length - 1];

    if (/抢占/.test(task.lastInterruptionReason)) {
      reasons.push('刚被高优任务打断，恢复连续性收益最高');
    }

    if (latestSnapshot?.done.length) {
      reasons.push(`上次做到：${latestSnapshot.done.join('；')}`);
    }

    if (latestSnapshot?.nextStep) {
      reasons.push(`下一步已明确：${latestSnapshot.nextStep}`);
    }

    if (reasons.length === 0) {
      reasons.push('上下文已恢复，可继续推进');
    }

    return reasons;
  }

  private buildCompletionNextStep(suggestion: { recommendedAction: string } | null): string {
    if (suggestion) {
      return suggestion.recommendedAction;
    }

    return '如需延续，可基于当前结果继续创建 follow-up 任务';
  }

  private appendOutput(...lines: string[]): void {
    if (lines.length === 0) return;
    this.output.push(...lines);
    this.notify();
  }

  private setCurrentTaskId(taskId: string | null): void {
    this.currentTaskId = taskId;
    this.notify();
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

    const state = this.runtimeState;
    const lines = [
      '',
      '┌─ 任务队列前五 ───────────────────────────────────┐',
      `│ 触发：${trigger}`,
      `│ 总览：执行中 ${state.runningTaskId ? 1 : 0} / 待执行 ${state.readyTaskIds.length} / 挂起 ${state.parkedTaskIds.length} / 阻塞 ${state.blockedTaskIds.length}`,
      ...entries.map((entry, index) => this.formatTaskQueueSnapshotEntry(entry, index + 1)),
      '└──────────────────────────────────────────────────┘',
    ];

    this.appendOutput(...lines);
  }

  private buildTaskQueueSnapshotEntries(): Array<{
    task: Task;
    score: number;
    reason: string;
    executionOrder: string;
  }> {
    const tasks = filterDurableTasks(this.deps.taskEngine.list())
      .filter(task => ['created', 'ready', 'running', 'parked', 'blocked'].includes(task.status));
    const runningTaskId = this.runtimeState.runningTaskId;
    const scored = tasks.map(task => {
      const evaluated = this.deps.orchestration.evaluateTask(task);
      return {
        task,
        score: evaluated.score.total,
        reason: evaluated.reasons[0] ?? this.defaultQueueSnapshotReason(task),
      };
    });

    scored.sort((a, b) => {
      const statusDelta = this.queueSnapshotStatusRank(b.task, runningTaskId) - this.queueSnapshotStatusRank(a.task, runningTaskId);
      if (statusDelta !== 0) {
        return statusDelta;
      }
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return new Date(a.task.createdAt).getTime() - new Date(b.task.createdAt).getTime();
    });

    let runnableOrder = 0;
    return scored.slice(0, TASK_QUEUE_SNAPSHOT_LIMIT).map(item => {
      const executable = ['running', 'ready', 'created'].includes(item.task.status)
        || (item.task.status === 'parked' && item.task.prioritySignals.isReady);
      let executionOrder = '-';
      if (item.task.id === runningTaskId) {
        executionOrder = '正在执行';
      } else if (executable) {
        runnableOrder += 1;
        executionOrder = `第 ${runnableOrder} 顺位`;
      } else if (item.task.status === 'parked') {
        executionOrder = '挂起待恢复';
      } else if (item.task.status === 'blocked') {
        executionOrder = '阻塞待解除';
      }

      return {
        ...item,
        executionOrder,
      };
    });
  }

  private queueSnapshotStatusRank(task: Task, runningTaskId: string | null): number {
    if (task.id === runningTaskId || task.status === 'running') {
      return 5;
    }
    if (task.status === 'ready' || task.status === 'created') {
      return 4;
    }
    if (task.status === 'parked' && task.prioritySignals.isReady) {
      return 3;
    }
    if (task.status === 'parked') {
      return 2;
    }
    if (task.status === 'blocked') {
      return 1;
    }
    return 0;
  }

  private defaultQueueSnapshotReason(task: Task): string {
    if (task.status === 'running') {
      return '当前正在执行';
    }
    if (task.status === 'parked') {
      return task.lastInterruptionReason || '任务已挂起';
    }
    if (task.status === 'blocked') {
      return task.dependencies.find(dependency => dependency.status === 'waiting')?.description || '等待解除阻塞';
    }
    if (task.prioritySignals.semanticPriorityReason) {
      return `语义优先级：${task.prioritySignals.semanticPriorityReason}`;
    }
    return task.lastSchedulingReason || '等待调度';
  }

  private formatTaskQueueSnapshotEntry(
    entry: {
      task: Task;
      score: number;
      reason: string;
      executionOrder: string;
    },
    index: number,
  ): string {
    const marker = entry.task.status === 'running'
      ? '执行中'
      : entry.task.status === 'parked'
        ? '挂起'
        : entry.task.status === 'blocked'
          ? '阻塞'
          : entry.task.status === 'ready'
            ? '待执行'
            : '已创建';
    const progress = Math.round(entry.task.prioritySignals.progressRatio * 100);
    return `│ ${index}. [${marker}] #${entry.task.id} ${entry.task.title} | 优先级 ${entry.score.toFixed(1)} | ${entry.executionOrder} | 进度 ${progress}% | ${entry.reason}`;
  }

  private persistSessionState(changes: {
    lastFocusedTaskId?: string | null;
    lastCompletedTaskId?: string | null;
    lastSessionId?: string | null;
  }): void {
    this.sessionStateRepo.upsert(changes);
  }

  private findMostRecentUnfinishedTask(excludeTaskIds: string[] = []): Task | null {
    const excluded = new Set(excludeTaskIds);
    return this.deps.taskEngine.list().find(task =>
      !excluded.has(task.id) && ['created', 'ready', 'running', 'parked', 'blocked'].includes(task.status)
    ) ?? null;
  }

  private async maybeHandlePersistedLastTaskContinuation(userInput: string): Promise<boolean> {
    if (!isContinuePreviousTaskInstruction(userInput)) {
      return false;
    }

    const state = this.sessionStateRepo.get();
    if (!state) {
      return false;
    }

    const lastFocusedTask = state.lastFocusedTaskId
      ? this.deps.taskEngine['taskRepo'].findById(state.lastFocusedTaskId)
      : null;
    const lastCompletedTask = state.lastCompletedTaskId
      ? this.deps.taskEngine['taskRepo'].findById(state.lastCompletedTaskId)
      : null;

    if (!lastFocusedTask && !lastCompletedTask) {
      return false;
    }

    const targetTask = lastFocusedTask ?? lastCompletedTask;
    if (!targetTask) {
      return false;
    }

    this.pendingProposalConfirmation = null;
    this.pendingRecallReview = null;

    if (['created', 'ready', 'running', 'parked', 'blocked'].includes(targetTask.status)) {
      const plan = planTaskExecution(targetTask, userInput);
      if (plan.mode === 'blocked') {
        this.appendOutput(`错误：${plan.error}`);
        return true;
      }

      if (plan.mode === 'fork-follow-up') {
        return false;
      }

      this.setCurrentTaskId(plan.executionTaskId);
      this.setFocusContext({ kind: 'task', taskId: plan.executionTaskId });
      this.appendOutput(`→ 命中上次任务指针 #${targetTask.id}`);
      await this.prepareTaskExecution(plan.executionTaskId, {
        userPrompt: userInput,
        contextTaskId: plan.contextTaskId,
        executionMode: targetTask.status === 'parked' ? 'resume-parked' : 'fresh',
        schedulingReason: targetTask.status === 'parked' ? '恢复上一个任务' : '继续上一个任务',
      });
      return true;
    }

    const completedTask = lastFocusedTask && ['done', 'archived', 'cancelled'].includes(lastFocusedTask.status)
      ? lastFocusedTask
      : lastCompletedTask;
    if (!completedTask) {
      return false;
    }

    const unfinishedTask = this.findMostRecentUnfinishedTask([completedTask.id]);
    const pending: PendingLastTaskConfirmation = {
      originalInput: userInput,
      completedTaskId: completedTask.id,
      unfinishedTaskId: unfinishedTask?.id ?? null,
    };
    if (unfinishedTask) {
      this.appendLastTaskAutoDecisionBlock(pending, 'resume-unfinished');
      await this.resumeUnfinishedTaskFromConfirmation(pending);
    } else {
      this.appendLastTaskAutoDecisionBlock(pending, 'follow-up');
      await this.createFollowUpFromCompletedTask(pending);
    }
    return true;
  }

  private async maybeHandleNaturalLanguageTaskResume(userInput: string): Promise<boolean> {
    if (typeof this.deps.llmBridge.resolveTaskResumeIntent !== 'function') {
      return false;
    }

    const candidates = filterDurableTasks(this.deps.taskEngine.list())
      .filter(task => task.status === 'parked' || task.status === 'blocked');
    if (candidates.length === 0) {
      return false;
    }

    const decision = await this.awaitWithTimeout(
      Promise.resolve(this.deps.llmBridge.resolveTaskResumeIntent(userInput, candidates.map(task => ({
        id: task.id,
        title: task.title,
        goal: task.goal,
        summary: task.summary || task.snapshots.at(-1)?.nextStep || task.lastInterruptionReason,
        status: task.status,
      })))),
      this.getLlmTimeoutMs(),
      { action: 'none' as const, taskId: null, reason: 'LLM resume intent 超时，fallback', confidence: 0 },
    );

    if (decision.action !== 'resume' || !decision.taskId || decision.confidence < 0.6) {
      return false;
    }

    const targetTask = this.deps.taskEngine['taskRepo'].findById(decision.taskId);
    if (!targetTask || (targetTask.status !== 'parked' && targetTask.status !== 'blocked')) {
      return false;
    }

    const plan = planTaskExecution(targetTask, userInput);
    if (plan.mode === 'blocked') {
      this.deps.taskEngine.unblock(targetTask.id);
      this.setCurrentTaskId(targetTask.id);
      this.setFocusContext({ kind: 'task', taskId: targetTask.id });
      this.appendOutput(
        `→ 命中已有阻塞任务 #${targetTask.id}`,
        `→ 语义判断：${decision.reason} (confidence=${decision.confidence.toFixed(2)})`,
        `→ 任务 #${targetTask.id} 已解除阻塞，继续执行`,
      );
      await this.prepareTaskExecution(targetTask.id, {
        userPrompt: userInput,
        contextTaskId: targetTask.id,
        executionMode: 'resume-blocked',
        schedulingReason: '自然语言恢复阻塞任务',
      });
      return true;
    }

    if (plan.mode === 'fork-follow-up') {
      return false;
    }

    this.setCurrentTaskId(plan.executionTaskId);
    this.setFocusContext({ kind: 'task', taskId: plan.executionTaskId });
    this.appendOutput(
      `→ 命中已有${targetTask.status === 'parked' ? '挂起' : '未完成'}任务 #${targetTask.id}`,
      `→ 语义判断：${decision.reason} (confidence=${decision.confidence.toFixed(2)})`,
    );
    await this.prepareTaskExecution(plan.executionTaskId, {
      userPrompt: userInput,
      contextTaskId: plan.contextTaskId,
      executionMode: targetTask.status === 'parked' ? 'resume-parked' : 'fresh',
      schedulingReason: targetTask.status === 'parked' ? '自然语言恢复挂起任务' : '自然语言继续已有任务',
    });
    return true;
  }

  private async maybeAutoResumeSatisfiedBlockedTask(userInput: string): Promise<boolean> {
    const decision = reconcileBlockedTasksFromInput(
      filterDurableTasks(this.deps.taskEngine.list()),
      userInput,
    );
    if (!decision) {
      return false;
    }

    for (const resourcePath of decision.newlyProvidedResources) {
      this.deps.taskEngine.attachResource(decision.task.id, resourcePath);
    }
    this.deps.taskEngine.unblock(decision.task.id);
    this.setCurrentTaskId(decision.task.id);
    this.setFocusContext({ kind: 'task', taskId: decision.task.id });
    this.appendOutput(
      `→ 检测到任务 #${decision.task.id} 的阻塞条件已满足`,
      `→ 原因：${decision.reason}`,
      decision.newlyProvidedResources.length > 0
        ? `→ 已自动关联 ${decision.newlyProvidedResources.length} 份补充材料`
        : '→ 任务已解除阻塞，继续执行',
    );
    await this.prepareTaskExecution(decision.task.id, {
      userPrompt: userInput,
      contextTaskId: decision.task.id,
      executionMode: 'resume-blocked',
      schedulingReason: `阻塞条件已满足：${decision.reason}`,
      newlyProvidedResources: decision.newlyProvidedResources,
    });
    return true;
  }

  private async handleCommand(userInput: string): Promise<boolean> {
    const result = await this.router.execute(userInput, {
      taskEngine: this.deps.taskEngine,
      memoryEngine: this.deps.memoryEngine,
      orchestration: this.deps.orchestration,
      executor: this.deps.executor,
      currentTaskId: this.currentTaskId,
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
      this.startExecutorRegisterWizard();
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
        }
      | undefined;

    if (schedulerData?.schedulerAction === 'resume' && schedulerData.taskId && schedulerData.mode) {
      const resumedTask = this.deps.taskEngine['taskRepo'].findById(schedulerData.taskId);
      if (resumedTask) {
        this.setCurrentTaskId(resumedTask.id);
        await this.prepareTaskExecution(resumedTask.id, {
          userPrompt: resumedTask.goal,
          contextTaskId: resumedTask.id,
          executionMode: schedulerData.mode,
          schedulingReason: schedulerData.mode === 'resume-blocked' ? '阻塞已解除' : '恢复已挂起任务',
          newlyProvidedResources: schedulerData.newlyProvidedResources,
        });
      }
    }

    return false;
  }

  private startExecutorRegisterWizard(): void {
    this.pendingExecutorRegisterWizard = {
      step: 'name',
      profile: {},
    };
    this.appendOutput(
      '1/8 Executor 名称是什么？',
      '示例：my-agent、pi-agent、finance-research-agent',
    );
  }

  private async handlePendingExecutorRegisterWizard(userInput: string): Promise<boolean> {
    const wizard = this.pendingExecutorRegisterWizard;
    if (!wizard) return false;

    const value = userInput.trim();
    if (/^(cancel|取消)$/iu.test(value)) {
      this.pendingExecutorRegisterWizard = null;
      this.appendOutput('已取消 Executor 注册向导');
      return true;
    }

    switch (wizard.step) {
      case 'name':
        if (!value) {
          this.appendOutput('名称不能为空。请输入 Executor 名称，或输入 cancel 取消。');
          return true;
        }
        wizard.profile.name = value;
        wizard.step = 'mode';
        this.appendOutput(
          '2/8 你想怎么补全运行信息？',
          '输入 url：我给项目地址，MetaClaw 尝试推断安装/运行信息',
          '输入 manual：我手动填写 command、args、check',
        );
        return true;

      case 'mode':
        if (/^url$/iu.test(value)) {
          wizard.step = 'projectUrl';
          this.appendOutput('3/8 请粘贴 Executor 项目地址（例如 GitHub URL）。');
          return true;
        }
        if (/^manual$/iu.test(value)) {
          wizard.step = 'command';
          this.appendOutput('3/8 本机运行这个 Executor 的命令是什么？示例：codex、my-agent、npx');
          return true;
        }
        this.appendOutput('请输入 url 或 manual。');
        return true;

      case 'projectUrl': {
        wizard.profile.projectUrl = value;
        const suggestion = await this.inferExecutorRuntimeFromProjectUrl(value);
        if (suggestion.command) {
          wizard.profile.runtimeCommand = suggestion.command;
          wizard.profile.runtimeArgs = suggestion.args;
          wizard.profile.runtimeCheckCommand = suggestion.checkCommand;
          this.appendOutput(
            '→ 已从项目地址推断出候选运行方式：',
            `  command=${suggestion.command}`,
            `  args=${suggestion.args.join(' ') || '{prompt}'}`,
            `  check=${suggestion.checkCommand || '-'}`,
            '如果正确，输入 y；如果不正确，输入 n 后手动填写。',
          );
          wizard.step = 'confirm';
          return true;
        }
        this.appendOutput(
          '→ 没能从项目地址可靠推断非交互运行方式，切换为手动填写。',
          '4/8 本机运行这个 Executor 的命令是什么？示例：codex、my-agent、npx',
        );
        wizard.step = 'command';
        return true;
      }

      case 'command':
        if (!value) {
          this.appendOutput('command 不能为空。示例：my-agent');
          return true;
        }
        wizard.profile.runtimeCommand = value;
        wizard.step = 'args';
        this.appendOutput(
          '4/8 非交互运行参数是什么？用 {prompt} 表示 MetaClaw 传入的任务提示。',
          '示例：exec --prompt {prompt}',
          '如果命令会把最后一个参数当 prompt，可直接输入 skip。',
        );
        return true;

      case 'args':
        wizard.profile.runtimeArgs = /^skip$/iu.test(value) ? [] : value.split(/\s+/).filter(Boolean);
        wizard.step = 'check';
        this.appendOutput(
          '5/8 安装检测命令是什么？',
          '示例：my-agent --version',
          '如果不填，将用 which <command> 检测；输入 skip 跳过自定义检测。',
        );
        return true;

      case 'check':
        wizard.profile.runtimeCheckCommand = /^skip$/iu.test(value) || !value ? null : value;
        wizard.step = 'domains';
        this.appendOutput('6/8 适合哪些领域？用逗号分隔。示例：software,research,finance');
        return true;

      case 'domains':
        wizard.profile.domains = splitCommaList(value);
        wizard.step = 'capabilities';
        this.appendOutput('7/8 具备哪些能力？用逗号分隔。示例：coding,tests,report_generation');
        return true;

      case 'capabilities':
        wizard.profile.capabilities = splitCommaList(value);
        wizard.step = 'confirm';
        this.appendOutput(this.formatExecutorRegisterWizardSummary(wizard), '确认注册？输入 y 注册，输入 n 取消。');
        return true;

      case 'confirm':
        if (!wizard.profile.domains) {
          if (/^n$/iu.test(value)) {
            wizard.step = 'command';
            this.appendOutput('请手动填写运行命令。示例：my-agent、npx');
            return true;
          }
          if (!/^y$/iu.test(value)) {
            this.appendOutput('请输入 y 或 n。');
            return true;
          }
          wizard.step = 'domains';
          this.appendOutput('6/8 适合哪些领域？用逗号分隔。示例：software,research,finance');
          return true;
        }

        if (/^n$/iu.test(value)) {
          this.pendingExecutorRegisterWizard = null;
          this.appendOutput('已取消 Executor 注册');
          return true;
        }
        if (!/^y$/iu.test(value)) {
          this.appendOutput('请输入 y 或 n。');
          return true;
        }
        this.completeExecutorRegisterWizard(wizard);
        this.pendingExecutorRegisterWizard = null;
        return true;
    }
  }

  private completeExecutorRegisterWizard(wizard: PendingExecutorRegisterWizard): void {
    if (!wizard.profile.name || !wizard.profile.runtimeCommand) {
      this.appendOutput('注册失败：缺少 name 或 command。请重新执行 /executor register wizard。');
      return;
    }

    const profileRepo = new ExecutorProfileRepo(this.deps.db);
    const existing = profileRepo.findByName(wizard.profile.name);
    const profile = {
      name: wizard.profile.name,
      domains: wizard.profile.domains ?? existing?.domains ?? [],
      capabilities: wizard.profile.capabilities ?? existing?.capabilities ?? [],
      inputTypes: existing?.inputTypes ?? ['text'],
      outputTypes: existing?.outputTypes ?? ['markdown'],
      strengths: existing?.strengths ?? [],
      weaknesses: existing?.weaknesses ?? [],
      primaryUseCases: existing?.primaryUseCases ?? [],
      avoidUseCases: existing?.avoidUseCases ?? [],
      intentAffinity: existing?.intentAffinity ?? {},
      riskLevel: existing?.riskLevel ?? 'medium' as const,
      availability: 'available' as const,
      historicalSuccess: existing?.historicalSuccess ?? 0.5,
      runtimeCommand: wizard.profile.runtimeCommand,
      runtimeArgs: wizard.profile.runtimeArgs ?? [],
      runtimeCheckCommand: wizard.profile.runtimeCheckCommand ?? null,
      projectUrl: wizard.profile.projectUrl ?? existing?.projectUrl ?? null,
    };
    profileRepo.upsert(profile);
    this.appendOutput(
      `已注册 Executor：${profile.name}`,
      `→ runtime: ${profile.runtimeCommand} ${profile.runtimeArgs.join(' ')}`.trim(),
      `→ check: ${profile.runtimeCheckCommand || `which ${profile.runtimeCommand}`}`,
      '→ 调度前会执行安装检测；检测失败会自动标记 unavailable 并回退默认 Executor。',
    );
  }

  private formatExecutorRegisterWizardSummary(wizard: PendingExecutorRegisterWizard): string {
    return [
      'Executor 注册信息：',
      `  name=${wizard.profile.name ?? '-'}`,
      `  projectUrl=${wizard.profile.projectUrl ?? '-'}`,
      `  command=${wizard.profile.runtimeCommand ?? '-'}`,
      `  args=${(wizard.profile.runtimeArgs ?? []).join(' ') || '{prompt}'}`,
      `  check=${wizard.profile.runtimeCheckCommand ?? `which ${wizard.profile.runtimeCommand ?? '<command>'}`}`,
      `  domains=${(wizard.profile.domains ?? []).join(',') || '-'}`,
      `  capabilities=${(wizard.profile.capabilities ?? []).join(',') || '-'}`,
    ].join('\n');
  }

  private async inferExecutorRuntimeFromProjectUrl(projectUrl: string): Promise<{
    command: string | null;
    args: string[];
    checkCommand: string | null;
  }> {
    const github = projectUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i);
    if (!github) {
      return { command: null, args: [], checkCommand: null };
    }

    const owner = github[1];
    const repo = github[2]?.replace(/\.git$/i, '');
    if (!owner || !repo) {
      return { command: null, args: [], checkCommand: null };
    }

    const packageJson = await this.fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/main/package.json`)
      ?? await this.fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/master/package.json`);
    if (packageJson) {
      try {
        const parsed = JSON.parse(packageJson) as { name?: string; bin?: string | Record<string, string> };
        const command = typeof parsed.bin === 'string'
          ? parsed.name
          : parsed.bin
            ? Object.keys(parsed.bin)[0]
            : parsed.name;
        if (command) {
          return {
            command,
            args: ['{prompt}'],
            checkCommand: `${command} --version`,
          };
        }
      } catch {
        // Fall through to README heuristics.
      }
    }

    const readme = await this.fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`)
      ?? await this.fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/master/README.md`);
    const npxMatch = readme?.match(/\bnpx\s+([@a-zA-Z0-9/_-]+)(?:\s+([^\n`]*))?/);
    if (npxMatch?.[1]) {
      return {
        command: 'npx',
        args: ['-y', npxMatch[1], '{prompt}'],
        checkCommand: `npx -y ${npxMatch[1]} --version`,
      };
    }

    return { command: null, args: [], checkCommand: null };
  }

  private async fetchText(url: string): Promise<string | null> {
    const result = spawnSync('curl', ['-L', '--silent', '--show-error', '--max-time', '20', url], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || !result.stdout) {
      return null;
    }
    return result.stdout;
  }

  private async handleNaturalLanguageInput(
    userInput: string,
    options: { skipRiskConfirmation?: boolean } = {},
  ): Promise<void> {
    if (this.maybeHandleNaturalLanguageTaskClear(userInput)) {
      return;
    }

    if (await this.maybeHandleNaturalLanguageTaskStatusQuery(userInput)) {
      return;
    }

    if (await this.maybeHandleNaturalLanguageTaskResume(userInput)) {
      return;
    }

    if (await this.maybeAutoResumeSatisfiedBlockedTask(userInput)) {
      return;
    }

    if (await this.maybeHandlePersistedLastTaskContinuation(userInput)) {
      return;
    }

    if (this.pendingLastTaskConfirmation) {
      const handled = await this.handlePendingLastTaskConfirmation(userInput);
      if (handled) {
        return;
      }
    }

    if (this.pendingProposalConfirmation) {
      const handled = this.handlePendingProposalConfirmation(userInput);
      if (handled) {
        return;
      }
    }

    if (this.pendingRecallReview) {
      const handled = this.handlePendingRecallReview();
      if (handled) {
        return;
      }
    }

    if (this.pendingPreferenceConfirmation) {
      const handled = this.handlePendingPreferenceConfirmation(userInput);
      if (handled) {
        return;
      }
    }

    if (this.pendingRiskConfirmation) {
      if (isRiskConfirmationInstruction(userInput)) {
        const pendingPrompt = this.pendingRiskConfirmation.prompt;
        this.pendingRiskConfirmation = null;
        this.appendOutput('→ 已确认高风险动作，继续执行原请求');
        await this.handleNaturalLanguageInput(pendingPrompt, {
          skipRiskConfirmation: true,
        });
        return;
      }

      if (isRiskCancellationInstruction(userInput)) {
        this.pendingRiskConfirmation = null;
        this.appendOutput('→ 已取消高风险动作，不再继续执行');
        return;
      }

      this.pendingRiskConfirmation = null;
      this.appendOutput('⚠️ 已清理遗留高风险确认状态；当前通道不再等待用户确认。');
      return;
    }

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

    const highConfidencePreferenceCandidates = extractHighConfidencePreferenceCandidates(userInput);
    if (highConfidencePreferenceCandidates.length > 0) {
      const lines: string[] = [];
      this.appendHighConfidencePreferenceCandidateBlocks(
        highConfidencePreferenceCandidates,
        `session:${this.deps.sessionId}`,
        lines,
      );

      if (lines.length > 0) {
        this.appendOutput(...lines);
      } else {
        this.appendOutput('→ 这条偏好已在候选或已确认记忆中，无需重复记录');
      }
      return;
    }

    if (!options.skipRiskConfirmation && isRiskyExternalActionInstruction(userInput)) {
      this.appendOutput(
        '⚠️ 检测到高风险外部动作。',
        '→ 当前通道不等待用户确认，已按原请求继续执行；执行器仍需遵守系统安全边界。',
      );
    }

    const durableTasks = filterDurableTasks(this.deps.taskEngine.list());
    const recentTasks = durableTasks.map(task => ({
      id: task.id,
      title: task.title,
      goal: task.goal,
      summary: task.summary,
      status: task.status,
    }));
    const llmRouteDecision = await this.resolveRouteDecision(userInput, recentTasks);
    let route: 'conversation' | 'task_control' | 'durable_task';
    if (llmRouteDecision.route === 'unknown') {
      route = classifyNaturalLanguageInput(userInput, durableTasks);
    } else {
      route = llmRouteDecision.route as 'conversation' | 'task_control' | 'durable_task';
    }
    const effectiveRoute = this.applyFocusAwareRouteOverride(userInput, route);
    const routeDecisionNote = this.buildFocusAwareRouteNote(userInput, effectiveRoute);

    if (effectiveRoute === 'conversation') {
      if (routeDecisionNote) {
        this.appendOutput(routeDecisionNote);
      }
      await this.handleConversationInput(userInput);
      return;
    }

    if (effectiveRoute === 'task_control' && recentTasks.length === 0) {
      this.appendOutput('当前没有可操作的任务');
      return;
    }

    const rawIntent = await this.resolveIntentDecision(userInput, recentTasks);
    const intent = this.applyFocusAwareIntentOverride(userInput, effectiveRoute, rawIntent);

    let taskId: string;
    if (intent.type === 'reference' && intent.taskId) {
      const referencedTask = this.deps.taskEngine['taskRepo'].findById(intent.taskId);
      if (!referencedTask) {
        throw new Error(`任务不存在: ${intent.taskId}`);
      }

      const plan = planTaskExecution(referencedTask, userInput);
      if (plan.mode === 'blocked') {
        const blockedReason = referencedTask.dependencies.find(dep => dep.status === 'waiting')?.description;
        if (blockedReason && isRecoverableExecutorFailure(blockedReason) && isRecoverableBlockedResumeInstruction(userInput)) {
          this.deps.taskEngine.unblock(referencedTask.id);
          this.appendOutput(
            `→ 关联到任务 #${referencedTask.id}`,
            `→ 任务 #${referencedTask.id} 已解除阻塞，继续执行`,
          );
          await this.prepareTaskExecution(referencedTask.id, {
            userPrompt: userInput,
            contextTaskId: referencedTask.id,
            executionMode: 'resume-blocked',
            schedulingReason: '网络已恢复，继续之前阻塞任务',
          });
          return;
        }

        this.appendOutput(`错误：${plan.error}`);
        return;
      }

      if (plan.mode === 'fork-follow-up') {
        if (effectiveRoute === 'task_control') {
          this.appendOutput(`未找到可继续或可恢复的任务 #${referencedTask.id}`);
          return;
        }
        const followUpTask = this.deps.taskEngine.create(plan.newTaskInput);
        taskId = followUpTask.id;
        await this.applySemanticPriority(taskId, userInput);
        this.setCurrentTaskId(taskId);
        this.setFocusContext({ kind: 'task', taskId });
        this.appendOutput(
          `→ 关联到任务 #${referencedTask.id}`,
          `→ 已完成任务不可直接重跑，创建跟进任务 #${taskId}`,
        );
        await this.prepareTaskExecution(taskId, {
          userPrompt: userInput,
          contextTaskId: plan.contextTaskId,
          executionMode: 'follow-up',
          schedulingReason: '跟进任务恢复',
        });
        return;
      }

      taskId = plan.executionTaskId;
      this.setCurrentTaskId(taskId);
      this.setFocusContext({ kind: 'task', taskId });
      this.appendOutput(`→ 关联到任务 #${taskId}`);
      if (referencedTask.status === 'running' && isResumeReferenceInstruction(userInput)) {
        this.appendOutput(`→ 任务 #${taskId} 已在执行中，无需再次排队`);
        this.refreshRuntimeState();
        return;
      }
      const executionMode = referencedTask.status === 'parked' ? 'resume-parked' : 'fresh';
      await this.applySemanticPriority(taskId, userInput);
      await this.prepareTaskExecution(taskId, {
        userPrompt: userInput,
        contextTaskId: taskId,
        executionMode,
        schedulingReason: referencedTask.status === 'parked' ? '恢复已挂起任务' : '用户提交',
      });
      return;
    }

    if (effectiveRoute === 'task_control') {
      this.appendOutput('未找到匹配的任务，可先用 /tasks 查看当前任务清单');
      return;
    }

    const inlineResources = extractInlineResourceMatches(userInput);
    const normalizedGoal = stripInlineResourceMatches(userInput, inlineResources) || userInput;
    const conversationDerived = this.focusContext?.kind === 'conversation'
      && isConversationDerivedWorkInstruction(userInput);
    const task = this.deps.taskEngine.create({
      title: normalizedGoal.slice(0, 50),
      goal: normalizedGoal,
      resources: inlineResources.map(resource => resource.resolvedPath),
    });
    taskId = task.id;
    await this.applySemanticPriority(taskId, userInput);
    this.setCurrentTaskId(taskId);
    this.setFocusContext({ kind: 'task', taskId });
    if (routeDecisionNote) {
      this.appendOutput(routeDecisionNote);
    }
    this.appendOutput(`任务 #${taskId} 已创建：${task.title}`);
    if (inlineResources.length > 0) {
      this.appendOutput(`→ 已自动关联 ${inlineResources.length} 份材料`);
    }

    await this.prepareTaskExecution(taskId, {
      userPrompt: userInput,
      contextTaskId: taskId,
      executionMode: 'fresh',
      schedulingReason: conversationDerived
        ? '按当前对话创建跟进任务'
        : buildSchedulingReason(userInput),
      includeRecentConversationContext: conversationDerived,
    });
  }

  private maybeHandleNaturalLanguageTaskClear(userInput: string): boolean {
    const scope = parseTaskClearInstruction(userInput);
    if (!scope) {
      return false;
    }

    const result = cancelTasksByScope(
      {
        taskEngine: this.deps.taskEngine,
        memoryEngine: this.deps.memoryEngine,
        orchestration: this.deps.orchestration,
        executor: this.deps.executor,
        currentTaskId: this.currentTaskId,
        db: this.deps.db,
        config: this.deps.config,
      },
      scope,
    );
    if (result.cancelled.some(task => task.id === this.currentTaskId)) {
      this.setCurrentTaskId(null);
      this.setFocusContext(null);
    }
    this.refreshRuntimeState();
    this.appendOutput(formatTaskClearResult(scope, result.cancelled, result.runningCancelled));
    return true;
  }

  private async maybeHandleNaturalLanguageTaskStatusQuery(userInput: string): Promise<boolean> {
    const durableTasks = filterDurableTasks(this.deps.taskEngine.list());
    const recentTasks = durableTasks.map(task => ({
      id: task.id,
      title: task.title,
      goal: task.goal,
      summary: task.summary,
      status: task.status,
    }));

    const fallbackOwnership = fallbackTaskStateOwnership(userInput);
    const resolvedOwnership = typeof this.deps.llmBridge.resolveTaskStateOwnership === 'function'
      ? await this.awaitWithTimeout(
          Promise.resolve(this.deps.llmBridge.resolveTaskStateOwnership(userInput, recentTasks)),
          this.getLlmTimeoutMs(),
          fallbackOwnership,
        )
      : fallbackOwnership;
    const ownership = resolvedOwnership.owner === 'metaclaw' || fallbackOwnership.owner !== 'metaclaw' || resolvedOwnership.confidence >= 0.75
      ? resolvedOwnership
      : fallbackOwnership;

    if (ownership.owner !== 'metaclaw' || ownership.confidence < 0.55) {
      return false;
    }

    const scope = ownership.scope ?? 'dashboard';
    this.appendOutput(this.formatNaturalLanguageTaskStatus(scope));
    this.refreshRuntimeState();
    return true;
  }

  private formatNaturalLanguageTaskStatus(scope: TaskStatusQueryScope): string {
    if (scope === 'blocked') {
      const blockedTasks = this.deps.orchestration.getBlockedTasks();
      if (blockedTasks.length === 0) {
        return '当前没有阻塞任务。';
      }

      return [
        `当前有 ${blockedTasks.length} 个阻塞任务：`,
        ...blockedTasks.map(task => [
          `  #${task.id} [BLOCKED] ${task.title}`,
          `    → 阻塞原因：${task.blockReason}`,
          `    → 建议动作：/task ${task.id} unblock，或直接补充材料/说明后让我继续`,
        ].join('\n')),
      ].join('\n');
    }

    if (scope === 'running') {
      const repo = this.deps.taskEngine['taskRepo'];
      const runningTask = repo.findByStatus('running')[0] ?? null;
      if (runningTask) {
        return [
          '当前有 1 个正在执行的任务：',
          `  #${runningTask.id} [RUNNING] ${runningTask.title}`,
          `    → 调度原因：${runningTask.lastSchedulingReason || '等待执行器返回'}`,
          `    → 最近更新时间：${runningTask.updatedAt}`,
        ].join('\n');
      }

      const activeTasks = filterDurableTasks(repo.findActive());
      const latestDone = filterDurableTasks(repo.findByStatus('done'))[0] ?? null;
      const lines = [
        '当前没有正在执行的任务。',
        `  总览：待执行 ${activeTasks.filter(task => task.status === 'ready' || task.status === 'created').length} / 挂起 ${activeTasks.filter(task => task.status === 'parked').length} / 阻塞 ${activeTasks.filter(task => task.status === 'blocked').length}`,
      ];
      if (latestDone) {
        lines.push(`  最近完成：#${latestDone.id} ${latestDone.title}`);
        if (latestDone.summary) {
          lines.push(`  摘要：${latestDone.summary}`);
        }
      }
      return lines.join('\n');
    }

    const dashboard = this.deps.orchestration.getDashboard();
    const lines = [
      '当前任务状态：',
      `  总览：活跃 ${dashboard.summary.active} / 阻塞 ${dashboard.summary.blocked} / 挂起 ${dashboard.summary.parked} / 已完成 ${dashboard.summary.done}`,
    ];

    if (dashboard.blockedTasks.length > 0) {
      lines.push('  阻塞任务：');
      lines.push(...dashboard.blockedTasks.map(task => `    #${task.id} ${task.title}，原因：${task.blockReason}`));
    }

    if (dashboard.readyTasks.length > 0) {
      lines.push('  待执行任务：');
      lines.push(...dashboard.readyTasks.slice(0, TASK_QUEUE_SNAPSHOT_LIMIT).map(task => `    #${task.id} ${task.title}`));
      if (dashboard.readyTasks.length > TASK_QUEUE_SNAPSHOT_LIMIT) {
        lines.push(`    ... 还有 ${dashboard.readyTasks.length - TASK_QUEUE_SNAPSHOT_LIMIT} 个待执行任务`);
      }
    }

    if (!dashboard.priorityTask) {
      lines.push('  当前没有需要优先提示的任务。');
    } else {
      lines.push(`  建议优先：#${dashboard.priorityTask.id} ${dashboard.priorityTask.title}`);
      lines.push(...dashboard.priorityTask.reasons.map(reason => `    → ${reason}`));
    }

    return lines.join('\n');
  }

  private async resolveRouteDecision(
    userInput: string,
    recentTasks: Array<{ id: string; title: string; goal: string; summary: string; status: Task['status'] }>,
  ): Promise<{ route: 'conversation' | 'task_control' | 'durable_task' | 'unknown'; reason: string }> {
    if (typeof this.deps.llmBridge.resolveRoute !== 'function') {
      return { route: 'unknown', reason: '缺少 resolveRoute，fallback' };
    }

    return this.awaitWithTimeout(
      Promise.resolve(this.deps.llmBridge.resolveRoute(userInput, recentTasks)),
      this.getLlmTimeoutMs(),
      { route: 'unknown', reason: 'LLM route 超时，fallback' },
    );
  }

  private async applySemanticPriority(taskId: string, userInput: string): Promise<void> {
    const task = this.deps.taskEngine['taskRepo'].findById(taskId);
    if (!task) {
      return;
    }

    const priority = typeof this.deps.llmBridge.resolveTaskPriority === 'function'
      ? await this.awaitWithTimeout(
          Promise.resolve(this.deps.llmBridge.resolveTaskPriority(userInput)),
          this.getLlmTimeoutMs(),
          { priority: parsePriorityHint(userInput), reason: 'LLM priority 超时，fallback' },
        )
      : { priority: parsePriorityHint(userInput), reason: '规则识别语义优先级' };

    this.deps.taskEngine['taskRepo'].update(taskId, {
      prioritySignals: {
        ...task.prioritySignals,
        semanticPriority: priority.priority,
        semanticPriorityReason: priority.reason,
      },
    });
  }

  private async classifyMissingSemanticPriorities(tasks: Task[]): Promise<void> {
    if (typeof this.deps.llmBridge.resolveTaskPriority !== 'function') {
      return;
    }

    for (const task of tasks) {
      const current = this.deps.taskEngine['taskRepo'].findById(task.id);
      if (!current || current.prioritySignals.semanticPriority) {
        continue;
      }

      await this.applySemanticPriority(current.id, current.goal || current.title);
    }
  }

  private async resolveIntentDecision(
    userInput: string,
    recentTasks: Array<{ id: string; title: string; goal: string; summary: string; status: Task['status'] }>,
  ): Promise<{ type: 'new' | 'reference'; taskId: string | null; reason: string }> {
    return this.awaitWithTimeout(
      Promise.resolve(this.deps.llmBridge.resolveIntent(userInput, recentTasks)),
      this.getLlmTimeoutMs(),
      { type: 'new', taskId: null, reason: 'LLM intent 超时，fallback' },
    );
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

  private handlePendingPreferenceConfirmation(userInput: string): boolean {
    if (!this.pendingPreferenceConfirmation) {
      return false;
    }

    const trimmed = userInput.trim();
    const pending = this.pendingPreferenceConfirmation;

    if (/^y$/iu.test(trimmed)) {
      try {
        const pref = this.deps.memoryEngine.confirm(pending.observationId, 'global');
        this.pendingPreferenceConfirmation = null;
        this.appendOutput(`已确认偏好 #${pref.id}: ${pref.content}`);
      } catch (error) {
        this.pendingPreferenceConfirmation = null;
        this.appendOutput(`确认失败: ${(error as Error).message}`);
      }
      return true;
    }

    if (/^n$/iu.test(trimmed)) {
      this.deps.memoryEngine.reject(pending.observationId);
      this.pendingPreferenceConfirmation = null;
      this.appendOutput(`已忽略候选偏好 #${pending.observationId}: ${pending.pattern}`);
      return true;
    }

    const editMatch = trimmed.match(/^e(?:\s+(.+))?$/iu);
    if (editMatch) {
      const editedContent = editMatch[1]?.trim();
      if (!editedContent) {
        this.appendOutput('→ 当前通道不进入编辑确认流程；请稍后用 `/memory add <内容>` 或 `/memory candidates` 管理。');
        return true;
      }

      this.deps.memoryEngine.reject(pending.observationId);
      const pref = this.deps.memoryEngine.addManual({
        content: editedContent,
        scope: 'global',
        type: 'domain',
      });
      this.pendingPreferenceConfirmation = null;
      this.appendOutput(`已编辑并确认偏好 #${pref.id}: ${pref.content}`);
      return true;
    }

    this.appendOutput('→ 当前通道不等待用户确认；候选偏好已保留，稍后可用 `/memory candidates` 管理。');
    return false;
  }

  private appendHighConfidencePreferenceCandidateBlocks(
    candidates: string[],
    sourceId: string,
    outputLines: string[],
  ): void {
    for (const candidate of candidates) {
      if (
        !sourceId.startsWith('task_')
        && !isHighRiskMemoryCandidate(candidate)
        && !this.hasExistingPreference(candidate)
      ) {
        const pref = this.deps.memoryEngine.addManual({
          content: candidate,
          scope: 'global',
          type: 'domain',
        });
        this.recordMemoryAuditEvent({
          taskId: null,
          memoryId: pref.id,
          action: 'auto_capture',
          score: 1,
          reason: '用户明确长期偏好，低风险自动写入',
          judgeSource: 'rule',
          evidence: [{ sourceId, content: candidate }],
        });
        outputLines.push(`→ 已自动记录偏好 #${pref.id}: ${pref.content}`);
        continue;
      }

      const { observation, shouldPromptConfirm } = this.deps.memoryEngine.observeCandidate(candidate, sourceId);
      if (!shouldPromptConfirm) {
        continue;
      }

      if (isHighRiskMemoryCandidate(candidate)) {
        outputLines.push(
          '',
          `⚠️ 高风险偏好不会静默写入："${candidate}"`,
          `   已保留为候选，不等待确认；如需保存，可稍后用 /memory confirm ${observation.id} 手动确认`,
        );
      } else {
        outputLines.push(
        '',
        `💡 检测到可能的长期偏好："${candidate}"`,
        `   已保留为候选，不等待确认；如需保存，可稍后用 /memory confirm ${observation.id} 手动确认`,
        );
      }
      this.notifyMemoryCandidate(observation.id, candidate, 'high-confidence');
    }
  }

  private hasExistingPreference(content: string): boolean {
    return this.deps.memoryEngine.list().some(preference => preference.content === content);
  }

  private recordMemoryAuditEvent(input: {
    taskId: string | null;
    memoryId: string;
    action: 'auto_capture' | 'auto_apply' | 'ask_review' | 'suppress';
    score: number | null;
    reason: string;
    judgeSource: string;
    evidence: unknown[];
  }): void {
    new MemoryAuditEventRepo(this.deps.db).insert({
      id: `memory_audit_${generateInteractionId()}`,
      taskId: input.taskId,
      memoryId: input.memoryId,
      action: input.action,
      score: input.score,
      reason: input.reason,
      judgeSource: input.judgeSource,
      evidence: input.evidence,
      createdAt: new Date().toISOString(),
    });
  }

  private notifyMemoryCandidate(
    observationId: string,
    pattern: string,
    source: 'high-confidence' | 'repeated-pattern',
  ): void {
    void this.notifier.notifyMemoryCandidate({
      observationId,
      pattern,
      source,
    }).catch(() => {
      // Notification failures must not block memory capture or task execution.
    });
  }

  private async handleConversationInput(userInput: string): Promise<void> {
    const conversationHistory = await this.deps.contextRecaller.recallAsync({
      taskId: '',
      sessionId: this.deps.sessionId,
      userInput,
    });

    try {
      const result = await this.deps.executor.execute({
        task: this.buildConversationTask(userInput),
        preferences: [],
        userPrompt: userInput,
        conversationHistory,
      });

      this.deps.db.prepare(
        'INSERT INTO interactions (id, task_id, session_id, user_input, system_output, executor_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        generateInteractionId(),
        null,
        this.deps.sessionId,
        userInput,
        result.output,
        this.deps.executor.name,
        new Date().toISOString(),
      );

      if (result.success) {
        this.setFocusContext({ kind: 'conversation', taskId: null });
        this.appendOutput(result.output);
        return;
      }

      this.appendOutput(`✗ 对话失败: ${result.error || '未知错误'}`);
    } catch (error) {
      this.appendOutput(`✗ 对话异常: ${(error as Error).message}`);
    }
  }

  private buildConversationTask(userInput: string): Task {
    const now = new Date().toISOString();
    return {
      id: `conv_${generateInteractionId()}`,
      title: '普通对话',
      goal: userInput,
      status: 'running',
      summary: '',
      snapshots: [],
      resources: [],
      artifacts: [],
      dependencies: [],
      prioritySignals: {
        dueAt: null,
        isReady: true,
        progressRatio: 0,
        blocksOthers: false,
        idleHours: 0,
      },
      injectedPreferences: [],
      lastSchedulingReason: '',
      lastInterruptionReason: '',
      interruptionCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async submitScheduledTask(taskId: string, request: QueuedExecutionRequest): Promise<void> {
    this.queuedExecution.set(taskId, request);
    const result = await this.scheduler.submit(taskId, {
      reason: request.schedulingReason || '新任务提交',
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

  private dispatchTask(taskId: string, context?: DispatchContext): Promise<void> {
    const dispatchPromise = (async () => {
      const request = this.queuedExecution.get(taskId) ?? this.buildFallbackExecutionRequest(taskId, context);
      if (!request) {
        this.appendOutput(`错误：任务 #${taskId} 缺少执行请求，无法派发`);
        return;
      }

      if (!this.queuedExecution.has(taskId)) {
        this.appendOutput(`→ 任务 #${taskId} 缺少待执行上下文，已根据持久化任务信息重建执行请求`);
      }

      const mergedRequest = context
        ? {
            ...request,
            executionMode: context.executionMode ?? request.executionMode,
            schedulingReason: context.schedulingReason ?? request.schedulingReason,
          }
        : request;
      this.queuedExecution.set(taskId, mergedRequest);
      await this.executeTask(taskId, mergedRequest);
    })();

    this.activeDispatches.add(dispatchPromise);
    void dispatchPromise.finally(() => {
      this.activeDispatches.delete(dispatchPromise);
      this.notify();
    });

    return dispatchPromise;
  }

  private buildFallbackExecutionRequest(taskId: string, context?: DispatchContext): QueuedExecutionRequest | null {
    const task = this.deps.taskEngine['taskRepo'].findById(taskId);
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
    const { userPrompt, contextTaskId, executionMode, schedulingReason, newlyProvidedResources } = request;
    const finishExecution = async (lines: string[], options: { scheduleNext?: boolean } = {}) => {
      this.runningExecutorNameByTask.delete(taskId);
      this.refreshRuntimeState();
      this.appendOutput(...lines);
      if (options.scheduleNext ?? true) {
        await this.scheduler.scheduleNext();
      }
      this.refreshRuntimeState();
      this.appendTaskQueueSnapshot('任务状态变更');
    };

    const task = this.deps.taskEngine['taskRepo'].findById(taskId);
    if (!task) {
      this.appendOutput(`错误：任务不存在 ${taskId}`);
      return;
    }

    this.maybeAppendExecutionGuidance(task, request);

    const keywords = userPrompt.split(/\s+/).filter(word => word.length > 2);
    const rawApprovedRecallSelection = this.approvedRecallSelections.get(taskId);
    const approvedRecallSelection = rawApprovedRecallSelection ?? {
      authoritative: false,
      resolvedPreferences: [],
      relatedTaskIds: [],
      acceptedMemoryResources: [],
    };
    this.approvedRecallSelections.delete(taskId);
    const preferences = rawApprovedRecallSelection?.authoritative
      ? this.deps.memoryEngine.list().filter(preference =>
          approvedRecallSelection.resolvedPreferences.some(resolved => resolved.id === preference.id)
        )
      : this.deps.memoryEngine.recall({ taskId, keywords, userInput: userPrompt });

    this.appendOutput('【提取最近历史记录上下文】');
    const conversationHistory = await this.deps.contextRecaller.recallAsync({
      taskId: contextTaskId,
      sessionId: this.deps.sessionId,
      userInput: userPrompt,
    });

    this.appendOutput('【构建执行上下文】');
    const executionContextBundle = await this.resumeContextBuilder.build({
      taskId,
      mode: executionMode,
      userInput: userPrompt,
      sessionId: this.deps.sessionId,
      schedulingReason,
      newlyProvidedResources,
      resolvedPreferencesOverride: approvedRecallSelection.authoritative
        ? approvedRecallSelection.resolvedPreferences
        : undefined,
      relatedTaskIdsOverride: approvedRecallSelection.authoritative
        ? approvedRecallSelection.relatedTaskIds
        : undefined,
      acceptedMemoryResources: approvedRecallSelection.authoritative
        ? approvedRecallSelection.acceptedMemoryResources
        : undefined,
      includeRecentConversationContext: request.includeRecentConversationContext,
    });
    this.appendOutput('【执行上下文准备完成】');
    if (executionContextBundle.memoryContext.resolvedPreferences.length > 0) {
      for (const resolvedPreference of executionContextBundle.memoryContext.resolvedPreferences) {
        this.deps.memoryEngine.recordUsage(resolvedPreference.id, taskId);
      }
      this.appendOutput(
        `→ 已注入 ${executionContextBundle.memoryContext.resolvedPreferences.length} 条偏好`,
        ...executionContextBundle.memoryContext.resolvedPreferences.map(preference =>
          `  - [${preference.scope}] ${preference.content} (confidence=${preference.confidence}, 命中原因：${preference.reason})`
        ),
      );
    }

    this.refreshRuntimeState();
    const routedExecutor = await this.ensureRoutedExecutorAvailability(
      this.resolveExecutorForTask(taskId, userPrompt),
    );
    this.runningExecutorNameByTask.set(taskId, this.formatExecutorRunLabel(routedExecutor.raceExecutors));
    this.appendExecutorRoutingDecision(routedExecutor);
    if (routedExecutor.fallbackReason) {
      this.appendOutput(`→ ${routedExecutor.fallbackReason}`);
    }
    if (routedExecutor.raceExecutors.length > 1) {
      this.appendOutput(`→ 调研竞速：同时派发给 ${routedExecutor.raceExecutors.map(executor => executor.name).join(' + ')}；谁先返回采用谁的结果，并自动终止其他执行器`);
    }

    this.refreshRuntimeState();
    this.appendOutput(`→ 正在执行任务 #${taskId}...`);

    try {
      const currentTask = this.deps.taskEngine['taskRepo'].findById(taskId);
      if (!currentTask) {
        await finishExecution([`错误：任务不存在 ${taskId}`]);
        return;
      }

      if (currentTask.status !== 'running') {
        this.runningExecutorNameByTask.delete(taskId);
        this.refreshRuntimeState();
        return;
      }

      this.ensureWorkspaceTargets(executionContextBundle.workspaceContext?.targetPaths ?? []);

      const executionId = `exec_${generateInteractionId()}`;
      const skillUsageEventRepo = new SkillUsageEventRepo(this.deps.db);

      const executorInput = {
        task: this.deps.taskEngine['taskRepo'].findById(taskId)!,
        preferences,
        userPrompt,
        conversationHistory,
        executionContextBundle,
      };
      const onProgress = (event: ExecutorProgressEvent, executor: ExecutorAdapter) => {
        const parsedSkillEvent = event.skillEvent ?? parseSkillUsageEventLine(event.text);
        const progressText = parsedSkillEvent
          ? `Skill ${parsedSkillEvent.skillName}: ${parsedSkillEvent.message}`
          : event.text;
        const progressLine = `${parsedSkillEvent ? '🛠️' : '·'} #${taskId} [${executor.name}] ${progressText}`;
        if (parsedSkillEvent) {
          skillUsageEventRepo.insert({
            id: `sue_${generateInteractionId()}`,
            taskId,
            executionId,
            executorName: executor.name,
            skillName: parsedSkillEvent.skillName,
            skillVersion: parsedSkillEvent.skillVersion,
            eventType: parsedSkillEvent.eventType,
            message: parsedSkillEvent.message,
            payload: parsedSkillEvent.payload,
            createdAt: new Date().toISOString(),
          });
        }
        if (this.lastProgressLineByTask.get(taskId) === progressLine) {
          return;
        }
        this.lastProgressLineByTask.set(taskId, progressLine);
        this.appendOutput(progressLine);
      };

      const raceResult = await this.executeWithOptionalRace(routedExecutor.raceExecutors, {
        ...executorInput,
        onProgress,
      });
      let { executor, result } = raceResult;
      if (raceResult.abortedExecutors.length > 0) {
        this.appendOutput(`→ ${executor.name} 已先返回，已终止：${raceResult.abortedExecutors.join('、')}`);
      }

      const latestTask = this.deps.taskEngine['taskRepo'].findById(taskId);
      if (!latestTask || latestTask.status !== 'running') {
        this.runningExecutorNameByTask.delete(taskId);
        this.refreshRuntimeState();
        return;
      }

      if (!result.success) {
        const fallbackResult = await this.executeCodexFallbackOnFailure({
          taskId,
          failedExecutor: executor,
          failedResult: result,
          input: executorInput,
          onProgress,
        });
        if (fallbackResult) {
          executor = fallbackResult.executor;
          result = fallbackResult.result;
        }
      }

      const taskAfterFallback = this.deps.taskEngine['taskRepo'].findById(taskId);
      if (!taskAfterFallback || taskAfterFallback.status !== 'running') {
        this.runningExecutorNameByTask.delete(taskId);
        this.refreshRuntimeState();
        return;
      }

      this.deps.db.prepare(
        'INSERT INTO interactions (id, task_id, session_id, user_input, system_output, executor_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        generateInteractionId(),
        taskId,
        this.deps.sessionId,
        userPrompt,
        result.output,
        executor.name,
        new Date().toISOString(),
      );

      if (result.success) {
        if (this.blockTaskOnUndeliverableExecutorOutput(taskId, result.output)) {
          new ExecutorRouteEventRepo(this.deps.db).updateResult(routedExecutor.eventId, 'blocked:undeliverable_output');
          await finishExecution([
            '✗ 执行未完成: 执行器返回了未交付结果，未生成任务产物',
            this.buildUndeliverableOutputHint(taskId),
          ], { scheduleNext: false });
          this.lastProgressLineByTask.delete(taskId);
          return;
        }

        new ExecutorRouteEventRepo(this.deps.db).updateResult(
          routedExecutor.eventId,
          executor.name === 'codex-cli' && routedExecutor.decision.selectedExecutor !== 'codex-cli'
            ? 'fallback_codex_success'
            : 'success',
        );
        const workspaceContext = executionContextBundle.workspaceContext;
        let artifactPaths = this.collectArtifactPaths(
          result.output,
          workspaceContext?.targetPaths ?? [],
        );
        artifactPaths = this.ensureFeishuDocumentArtifact(
          result.output,
          artifactPaths,
          workspaceContext,
          executionContextBundle.memoryContext.resolvedPreferences,
          userPrompt,
        );
        const taskSummary = this.buildTaskResultSummary(result.output, artifactPaths, workspaceContext);
        this.deps.taskEngine['taskRepo'].update(taskId, {
          summary: taskSummary,
          injectedPreferences: executionContextBundle.memoryContext.resolvedPreferences.map(preference => preference.id),
          artifacts: artifactPaths,
        });
        this.setFocusContext({ kind: 'task', taskId });

        const completionLines: string[] = [];
        const patterns = extractPatterns(userPrompt);
        for (const pattern of patterns) {
          const { observation, shouldPromptConfirm } = this.deps.memoryEngine.observe(pattern, taskId);
          if (shouldPromptConfirm) {
            completionLines.push(
              '',
              `💡 检测到重复模式（${observation.occurrenceCount}次）："${pattern}"`,
              `   已保留为候选，不等待确认；如需保存，可稍后用 /memory confirm ${observation.id} 手动确认`,
            );
            this.notifyMemoryCandidate(observation.id, pattern, 'repeated-pattern');
          }
        }
        this.appendHighConfidencePreferenceCandidateBlocks(
          extractHighConfidencePreferenceCandidates(result.output),
          taskId,
          completionLines,
        );

        this.deps.taskEngine.transition(taskId, 'done');
        this.persistSessionState({
          lastFocusedTaskId: taskId,
          lastCompletedTaskId: taskId,
        });
        const suggestion = this.deps.orchestration.suggestNext(taskId);
        const nextProposal = this.deps.orchestration.suggestNextProposal(taskId);
        completionLines.push(
          `✓ 任务完成 (${(result.durationMs / 1000).toFixed(1)}s)`,
          '',
          '┌─ 任务结果 ───────────────────────────────────────┐',
          `│ 摘要: ${taskSummary || '无'}`,
          `│ 下一步: ${this.buildCompletionNextStep(suggestion)}`,
          '└──────────────────────────────────────────────────┘',
        );
        if (workspaceContext?.allowFilesystem) {
          completionLines.push(
            '',
            `→ 文件输出目录: ${workspaceContext.targetPaths[0]}`,
            '→ 已省略文件正文输出，请直接查看生成文件',
          );
        } else {
          completionLines.push('', result.output);
        }
        if (artifactPaths.length > 0) {
          completionLines.push(
            '',
            `→ 已记录 ${artifactPaths.length} 个任务产物`,
            ...artifactPaths.map(path => `   - ${path}`),
          );
        }

        if (suggestion) {
          this.setLatestGuidance('完成后建议', suggestion);
          completionLines.push(
            '',
            '┌─ 操作指引 ───────────────────────────────────────┐',
            '│ 场景：完成后建议',
            `│ 推荐动作：${suggestion.recommendedAction}`,
            `│ 目标任务：#${suggestion.taskId}${this.buildSuggestionTaskTitleSuffix(suggestion.taskId)}`,
          );
          if (suggestion.reasons.length === 0) {
            completionLines.push('│ 原因：已有后续任务可立即继续');
          } else {
            suggestion.reasons.forEach((reason, index) => {
              completionLines.push(`${index === 0 ? '│ 原因：' : '│       '}${reason}`);
            });
          }
          completionLines.push('└──────────────────────────────────────────────────┘');
        }

        await finishExecution(completionLines);
        if (nextProposal) {
          this.queueProposal('完成后建议', nextProposal);
        }
        this.lastProgressLineByTask.delete(taskId);
        return;
      }

      const errorMessage = result.error || '未知错误';
      new ExecutorRouteEventRepo(this.deps.db).updateResult(routedExecutor.eventId, `failed:${errorMessage}`);
      if (this.blockTaskOnRecoverableFailure(taskId, errorMessage)) {
        await finishExecution([
          `✗ 执行失败: ${errorMessage}`,
          this.buildRecoverableFailureHint(taskId, errorMessage),
        ], { scheduleNext: false });
        this.lastProgressLineByTask.delete(taskId);
        return;
      }

      this.deps.taskEngine.transition(taskId, 'parked');
      await finishExecution([`✗ 执行失败: ${errorMessage}`]);
      this.lastProgressLineByTask.delete(taskId);
    } catch (error) {
      new ExecutorRouteEventRepo(this.deps.db).updateResult(routedExecutor.eventId, `exception:${(error as Error).message}`);
      const currentTask = this.deps.taskEngine['taskRepo'].findById(taskId);
      if (currentTask?.status === 'running') {
        const errorMessage = (error as Error).message;
        if (this.blockTaskOnRecoverableFailure(taskId, errorMessage)) {
          await finishExecution([
            `✗ 执行异常: ${errorMessage}`,
            this.buildRecoverableFailureHint(taskId, errorMessage),
          ], { scheduleNext: false });
          this.lastProgressLineByTask.delete(taskId);
          return;
        }

        this.deps.taskEngine.transition(taskId, 'parked');
        await finishExecution([`✗ 执行异常: ${errorMessage}`]);
        this.lastProgressLineByTask.delete(taskId);
        return;
      }

      this.lastProgressLineByTask.delete(taskId);
      this.runningExecutorNameByTask.delete(taskId);
      this.refreshRuntimeState();
    }
  }

  private blockTaskOnRecoverableFailure(taskId: string, errorMessage: string): boolean {
    if (!isRecoverableExecutorFailure(errorMessage)) {
      return false;
    }

    const currentTask = this.deps.taskEngine['taskRepo'].findById(taskId);
    if (!currentTask || currentTask.status !== 'running') {
      return false;
    }

    this.deps.taskEngine.block(taskId, {
      taskId,
      type: 'manual',
      description: errorMessage,
      status: 'waiting',
    });
    return true;
  }

  private blockTaskOnUndeliverableExecutorOutput(taskId: string, output: string): boolean {
    if (!isUndeliverableExecutorOutput(output)) {
      return false;
    }

    const currentTask = this.deps.taskEngine['taskRepo'].findById(taskId);
    if (!currentTask || currentTask.status !== 'running') {
      return false;
    }

    this.deps.taskEngine.block(taskId, {
      taskId,
      type: 'manual',
      description: '执行器返回未完成说明，未生成最终产物',
      status: 'waiting',
    });
    return true;
  }

  private buildUndeliverableOutputHint(taskId: string): string {
    return `→ 任务 #${taskId} 已转为阻塞；执行器说明命令被拒绝、超时或报告尚未写入。请补充授权/继续指令后执行 /task ${taskId} unblock，或直接说“继续完成刚才的报告”`;
  }

  private buildRecoverableFailureHint(taskId: string, errorMessage: string): string {
    if (isPermissionFailure(errorMessage)) {
      return `→ 任务 #${taskId} 已转为阻塞，请先确认相关目录权限或系统授权；确认后执行 /task ${taskId} unblock，或直接说“已授权，继续刚才那个任务”`;
    }

    if (/执行器空闲超时|executor idle timeout/i.test(errorMessage)) {
      return `→ 任务 #${taskId} 已转为阻塞；执行器长时间没有输出或状态变化，可能卡住。请检查执行器是否仍在正常推进，必要时补充信息后执行 /task ${taskId} unblock 继续`;
    }

    return `→ 任务 #${taskId} 已转为阻塞，排除问题后执行 /task ${taskId} unblock 继续`;
  }

  private collectArtifactPaths(output: string, targetPaths: string[]): string[] {
    if (targetPaths.length === 0 || !output.trim()) {
      return [];
    }

    const matches = output.match(/\/[^\s`"'，。,；;：！？（）()<>\]]+/g) ?? [];
    const normalized = matches
      .map(path => path.replace(/[.,;:!?）)\]]+$/u, ''))
      .filter(path => targetPaths.some(targetPath => path.startsWith(targetPath)))
      .filter(path => existsSync(path));

    return Array.from(new Set(normalized));
  }

  private ensureFeishuDocumentArtifact(
    output: string,
    artifactPaths: string[],
    workspaceContext: { allowFilesystem: boolean; targetPaths: string[] } | undefined,
    preferences: ResolvedPreference[],
    userPrompt: string,
  ): string[] {
    if (!workspaceContext?.allowFilesystem || artifactPaths.some(path => /\.(md|markdown)$/i.test(path))) {
      return artifactPaths;
    }

    const needsFeishuDocumentDelivery = [userPrompt, ...preferences.map(preference => preference.content)]
      .some(text => /(飞书云文档|飞书文档|云文档|在线预览)/u.test(text));
    if (!needsFeishuDocumentDelivery || !output.trim() || isUndeliverableExecutorOutput(output)) {
      return artifactPaths;
    }

    const targetDirectory = workspaceContext.targetPaths[0];
    if (!targetDirectory) {
      return artifactPaths;
    }

    mkdirSync(targetDirectory, { recursive: true });
    const artifactPath = resolve(targetDirectory, 'feishu-document.md');
    writeFileSync(artifactPath, output.trimEnd() + '\n', 'utf-8');
    return Array.from(new Set([...artifactPaths, artifactPath]));
  }

  private ensureWorkspaceTargets(targetPaths: string[]): void {
    for (const targetPath of targetPaths) {
      mkdirSync(targetPath, { recursive: true });
    }
  }

  private buildTaskResultSummary(
    output: string,
    artifactPaths: string[],
    workspaceContext?: { allowFilesystem: boolean; targetPaths: string[] },
  ): string {
    if (!workspaceContext?.allowFilesystem) {
      return output.slice(0, 200) || '无';
    }

    const conciseSummary = this.extractConciseExecutorSummary(output, artifactPaths);
    if (conciseSummary) {
      return conciseSummary;
    }

    if (artifactPaths.length > 0) {
      if (artifactPaths.length === 1) {
        return `已写入任务文件：${artifactPaths[0]}`;
      }
      return `已写入 ${artifactPaths.length} 个任务文件到 ${workspaceContext.targetPaths[0]}`;
    }

    return `已完成文件写入任务，目标目录：${workspaceContext.targetPaths[0]}`;
  }

  private extractConciseExecutorSummary(output: string, artifactPaths: string[]): string | null {
    const lines = output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      if (/^```/.test(line)) {
        continue;
      }
      if (/(<!DOCTYPE|<html|<body|<head|<script|<style)/i.test(line)) {
        continue;
      }

      let normalized = line;
      for (const artifactPath of artifactPaths) {
        normalized = normalized.replace(artifactPath, '').trim();
      }
      normalized = normalized
        .replace(/`{1,3}\s*`{1,3}/g, '')
        .replace(/["“”'‘’]\s*["“”'‘’]/g, '')
        .trim();
      normalized = normalized.replace(/[：:，,\-]+$/u, '').trim();

      if (!normalized) {
        continue;
      }
      if (/^(已创建文件|已保存文件|文件已创建|保存路径|路径)$/u.test(normalized)) {
        continue;
      }
      if (/<[a-z][^>]*>/i.test(normalized)) {
        continue;
      }

      return normalized.slice(0, 200);
    }

    return null;
  }

  private setFocusContext(focus: FocusContext | null): void {
    this.focusContext = focus;
    if (focus?.kind === 'task' && focus.taskId) {
      this.persistSessionState({ lastFocusedTaskId: focus.taskId });
    }
  }

  private applyFocusAwareRouteOverride(
    userInput: string,
    route: 'conversation' | 'task_control' | 'durable_task',
  ): 'conversation' | 'task_control' | 'durable_task' {
    if (this.focusContext?.kind === 'conversation' && !isExplicitTaskControlReference(userInput)) {
      if (isConversationalContinuationInstruction(userInput)) {
        return 'conversation';
      }

      if (isConversationDerivedWorkInstruction(userInput)) {
        return 'durable_task';
      }
    }

    return route;
  }

  private applyFocusAwareIntentOverride(
    userInput: string,
    route: 'conversation' | 'task_control' | 'durable_task',
    intent: { type: 'new' | 'reference'; taskId: string | null; reason: string },
  ): { type: 'new' | 'reference'; taskId: string | null; reason: string } {
    if (
      this.focusContext?.kind === 'conversation'
      && route === 'durable_task'
      && intent.type === 'reference'
      && !isExplicitTaskControlReference(userInput)
      && isConversationDerivedWorkInstruction(userInput)
    ) {
      return {
        type: 'new',
        taskId: null,
        reason: '当前对话衍生的后续动作，忽略旧任务引用',
      };
    }

    return intent;
  }

  private buildFocusAwareRouteNote(
    userInput: string,
    route: 'conversation' | 'task_control' | 'durable_task',
  ): string | null {
    if (this.focusContext?.kind !== 'conversation' || isExplicitTaskControlReference(userInput)) {
      return null;
    }

    if (route === 'conversation' && isConversationalContinuationInstruction(userInput)) {
      return '→ 延续当前对话，不恢复旧任务';
    }

    if (route === 'durable_task' && isConversationDerivedWorkInstruction(userInput)) {
      return '→ 按当前对话创建跟进任务';
    }

    return null;
  }

  private recoverOrphanedRunningTasks(): Task[] {
    const runningTasks = this.deps.taskEngine['taskRepo'].findByStatus('running');
    const recovered: Task[] = [];

    for (const task of runningTasks) {
      const interruptionReason = 'Metaclaw 重启，原执行器会话已断开';
      this.deps.taskEngine.park(task.id, interruptionReason, {
        done: task.summary ? [task.summary] : [],
        pending: [task.goal],
        nextStep: '确认环境后恢复当前任务',
        pauseReason: interruptionReason,
      });
      this.deps.taskEngine['taskRepo'].update(task.id, {
        lastInterruptionReason: interruptionReason,
        interruptionCount: task.interruptionCount + 1,
      });
      const parkedTask = this.deps.taskEngine['taskRepo'].findById(task.id);
      if (parkedTask) {
        recovered.push(parkedTask);
      }
    }

    return recovered;
  }

  private resumeUnfinishedTasksOnStartup(recoveredRunningTasks: Task[]): void {
    if (this.buildStartupResumeCandidates(recoveredRunningTasks).length === 0) {
      return;
    }

    const startupPromise = (async () => {
      const taskId = await this.scheduler.scheduleNext();
      if (taskId) {
        this.appendStartupResumeLine(taskId);
      }
    })();

    this.activeDispatches.add(startupPromise);
    void startupPromise.finally(() => {
      this.activeDispatches.delete(startupPromise);
      this.notify();
    });
  }

  private buildStartupResumeCandidates(recoveredRunningTasks: Task[]): Task[] {
    const byId = new Map<string, Task>();

    for (const task of recoveredRunningTasks) {
      byId.set(task.id, task);
    }

    for (const task of filterDurableTasks(this.deps.taskEngine.list())) {
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
    const task = this.deps.taskEngine['taskRepo'].findById(taskId);
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

function isUndeliverableExecutorOutput(output: string): boolean {
  const normalized = output.trim();
  if (!normalized) {
    return false;
  }

  return /Timeout\s+—\s+denying command/i.test(normalized)
    || /denying command/i.test(normalized)
    || /停止当前\s*workflow|等待用户响应|需要你允许后/u.test(normalized)
    || /还没有生成最终\s*Markdown\s*文件|尚未写入|没有生成最终\s*Markdown/u.test(normalized)
    || /未完成项：[\s\S]{0,300}(详细报告|Markdown|文件).*尚未写入/u.test(normalized);
}
