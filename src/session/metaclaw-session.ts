import type Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import type {
  Config,
  GuidanceActionType,
  GuidanceProposal,
  PreferenceMemoryCandidate,
  RecallReviewCard,
  ResolvedPreference,
  RuntimeState,
  Task,
  TaskMemoryCandidate,
} from '../core/types.js';
import type { TaskEngine } from '../core/task-engine.js';
import type { MemoryEngine } from '../core/memory-engine.js';
import type { OrchestrationEngine } from '../core/orchestration.js';
import type { ExecutorAdapter } from '../executor/adapter.js';
import type { ContextRecaller } from '../core/context-recaller.js';
import type { LlmBridge } from '../core/llm-bridge.js';
import { SchedulerEngine } from '../core/scheduler.js';
import type { DispatchContext } from '../core/scheduler.js';
import { classifyNaturalLanguageInput, filterDurableTasks } from '../core/task-routing.js';
import { ResumeContextBuilder } from '../core/resume-context-builder.js';
import { RecallReviewBuilder } from '../core/recall-review-builder.js';
import { RecallPolicyService } from '../core/recall-policy-service.js';
import { CommandRouter } from '../commands/router.js';
import { tasksCommand, taskCommand } from '../commands/task-commands.js';
import { memoryCommand } from '../commands/memory-commands.js';
import { dashboardCommand, attachCommand, historyCommand, configCommand, helpCommand, exitCommand } from '../commands/global-commands.js';
import { generateInteractionId } from '../utils/id.js';
import { isPermissionFailure, isRecoverableExecutorFailure } from '../executor/error-utils.js';
import { RecallReviewPolicyRepo } from '../storage/recall-review-policy-repo.js';
import { SessionStateRepo } from '../storage/session-state-repo.js';
import {
  buildSchedulingReason,
  extractPatterns,
  isContinuePreviousTaskInstruction,
  isConversationDerivedWorkInstruction,
  isConversationalContinuationInstruction,
  isExplicitTaskControlReference,
  isRiskCancellationInstruction,
  isRiskConfirmationInstruction,
  isRiskyExternalActionInstruction,
  isRecoverableBlockedResumeInstruction,
  isResumeReferenceInstruction,
  parseExplicitRemember,
  parsePriorityHint,
  planTaskExecution,
  extractInlineResourceMatches,
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

interface PendingRecallReview {
  taskId: string;
  taskTitle: string;
  request: QueuedExecutionRequest;
  proposalType: GuidanceActionType | null;
  card: RecallReviewCard;
  preferenceCandidates: PreferenceMemoryCandidate[];
  taskCandidates: TaskMemoryCandidate[];
  selectionItems: Array<
    | { kind: 'preference'; candidate: PreferenceMemoryCandidate }
    | { kind: 'task'; candidate: TaskMemoryCandidate }
  >;
  auditId: string | null;
}

const BUSY_LLM_TIMEOUT_MS = 250;
const DEFAULT_LLM_TIMEOUT_MS = 5_000;

export class MetaclawSession {
  private output: string[] = [];
  private currentTaskId: string | null = null;
  private focusContext: FocusContext | null = null;
  private runtimeState: RuntimeState = {
    runningTaskId: null,
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
  private approvedRecallSelections = new Map<string, PendingRecallSelection>();
  private initialized = false;
  private listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private queuedExecution = new Map<string, QueuedExecutionRequest>();
  private activeDispatches = new Set<Promise<void>>();
  private lastProgressLineByTask = new Map<string, string>();
  private lastReminderAt: number | null = null;
  private lastReminderFingerprint: string | null = null;
  private readonly resumeContextBuilder: ResumeContextBuilder;
  private readonly router: CommandRouter;
  private readonly scheduler: SchedulerEngine;
  private readonly sessionStateRepo: SessionStateRepo;

  constructor(private deps: MetaclawSessionDeps) {
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

  initialize(): void {
    if (this.initialized) return;

    const recoveredRunningTasks = this.recoverOrphanedRunningTasks();

    if (this.deps.config.ui.dashboard_on_start) {
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

    const startupProposal = this.deps.orchestration.generateProposals('startup')[0];
    if (startupProposal) {
      this.queueProposal('启动建议', startupProposal);
    }

    this.initialized = true;
    this.refreshRuntimeState();
    this.notify();
    this.resumeUnfinishedTasksOnStartup(recoveredRunningTasks);
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
      '│ 请输入 [y] 接受并继续恢复 / [n] 暂不处理 / [r] 重新查看',
      '└──────────────────────────────────────────────────┘',
    );
  }

  private appendRecallReviewBlock(review: PendingRecallReview): void {
    const lines = [
      '',
      '┌─ 记忆召回确认 ───────────────────────────────────┐',
      `│ 当前任务：#${review.taskId} ${review.taskTitle}`,
    ];

    if (review.selectionItems.length === 0) {
      lines.push('│ 没有可确认的召回项，将直接继续执行');
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
      '│ 请输入 [y] 全部采用 / [n] 全部忽略 / [s 编号...] 部分采用 / [a] 后续同类自动采用 / [r] 重新查看',
      '└──────────────────────────────────────────────────┘',
    );

    this.appendOutput(...lines);
  }

  private appendLastTaskConfirmationBlock(pending: PendingLastTaskConfirmation): void {
    const completedTask = this.deps.taskEngine['taskRepo'].findById(pending.completedTaskId);
    if (!completedTask) {
      return;
    }

    const unfinishedTask = pending.unfinishedTaskId
      ? this.deps.taskEngine['taskRepo'].findById(pending.unfinishedTaskId)
      : null;

    const lines = [
      '',
      '┌─ 上次任务确认 ───────────────────────────────────┐',
      `│ 上一个任务：#${completedTask.id} ${completedTask.title}`,
      '│ 上一个任务已完成。',
      '│ 请选择如何继续：',
      '│ [f] 基于该任务创建 follow-up',
      unfinishedTask
        ? `│ [u] 改为恢复最近未完成任务 #${unfinishedTask.id} ${unfinishedTask.title}`
        : '│ [u] 当前没有可恢复的未完成任务',
      '│ [n] 本次不自动关联',
      '│ [r] 重新查看',
      '└──────────────────────────────────────────────────┘',
    ];

    this.appendOutput(...lines);
  }

  private queueProposal(scene: string, proposal: GuidanceProposal): void {
    if (this.pendingProposalConfirmation || this.pendingRecallReview) {
      return;
    }

    this.pendingProposalConfirmation = {
      scene,
      proposal,
    };
    this.appendProposalBlock(scene, proposal);
  }

  private createRecallPolicyService(): RecallPolicyService {
    return new RecallPolicyService(new RecallReviewPolicyRepo(this.deps.db));
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

    const decision = this.createRecallPolicyService().resolve({
      proposalType,
      taskCandidates: recallResult.taskCandidates,
      preferenceCandidates: recallResult.preferenceCandidates,
    });

    if (recallResult.preferenceCandidates.length === 0 && recallResult.taskCandidates.length === 0) {
      await this.submitScheduledTask(taskId, request);
      return;
    }

    if (!decision.requiresReview) {
      this.approvedRecallSelections.set(
        taskId,
        this.buildAcceptedRecallSelection(
          recallResult.preferenceCandidates,
          recallResult.taskCandidates,
        ),
      );
      this.appendOutput(
        '',
        '┌─ 记忆自动采用 ───────────────────────────────────┐',
        `│ 当前任务：#${taskId} ${task.title}`,
        `│ 已按既有策略自动采用 ${recallResult.preferenceCandidates.length + recallResult.taskCandidates.length} 条召回内容`,
        '└──────────────────────────────────────────────────┘',
      );
      await this.submitScheduledTask(taskId, request);
      return;
    }

    const reviewBuilder = new RecallReviewBuilder();
    const card = reviewBuilder.build({
      taskCandidates: recallResult.taskCandidates,
      preferenceCandidates: recallResult.preferenceCandidates,
    });
    const selectionItems = [
      ...recallResult.preferenceCandidates.map(candidate => ({ kind: 'preference' as const, candidate })),
      ...recallResult.taskCandidates.map(candidate => ({ kind: 'task' as const, candidate })),
    ];

    this.pendingRecallReview = {
      taskId,
      taskTitle: task.title,
      request,
      proposalType,
      card,
      preferenceCandidates: recallResult.preferenceCandidates,
      taskCandidates: recallResult.taskCandidates,
      selectionItems,
      auditId: recallResult.auditId,
    };
    this.appendRecallReviewBlock(this.pendingRecallReview);
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

  private parseRecallSelectionInput(input: string, maxIndex: number): number[] | null {
    const match = input.trim().match(/^s(?:\s+(.+))$/iu);
    if (!match) {
      return null;
    }

    const indexes = (match[1] ?? '')
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

  private handlePendingLastTaskConfirmation(userInput: string): boolean {
    if (!this.pendingLastTaskConfirmation) {
      return false;
    }

    const trimmed = userInput.trim();
    const pending = this.pendingLastTaskConfirmation;

    if (/^r$/iu.test(trimmed)) {
      this.appendLastTaskConfirmationBlock(pending);
      return true;
    }

    if (/^n$/iu.test(trimmed)) {
      this.pendingLastTaskConfirmation = null;
      this.appendOutput('→ 已取消本次跨会话自动关联');
      return true;
    }

    if (/^f$/iu.test(trimmed)) {
      this.pendingLastTaskConfirmation = null;
      void this.createFollowUpFromCompletedTask(pending).catch(error => {
        this.appendOutput(`错误: ${(error as Error).message}`);
      });
      return true;
    }

    if (/^u$/iu.test(trimmed)) {
      if (!pending.unfinishedTaskId) {
        this.appendOutput('→ 当前没有可恢复的未完成任务，请输入 `f` / `n` / `r`。');
        return true;
      }

      this.pendingLastTaskConfirmation = null;
      void this.resumeUnfinishedTaskFromConfirmation(pending).catch(error => {
        this.appendOutput(`错误: ${(error as Error).message}`);
      });
      return true;
    }

    this.appendOutput('→ 当前有待确认的上次任务恢复，可输入 `f` / `u` / `n` / `r`。');
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
      priorityHint: parsePriorityHint(pending.originalInput),
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
      priorityHint: parsePriorityHint(pending.originalInput),
    });
  }

  private handlePendingRecallReview(userInput: string): boolean {
    if (!this.pendingRecallReview) {
      return false;
    }

    const trimmed = userInput.trim();
    const pending = this.pendingRecallReview;

    if (/^r$/iu.test(trimmed)) {
      this.appendRecallReviewBlock(pending);
      return true;
    }

    if (/^y$/iu.test(trimmed)) {
      this.pendingRecallReview = null;
      const selection = this.buildAcceptedRecallSelection(
        pending.preferenceCandidates,
        pending.taskCandidates,
      );
      this.approvedRecallSelections.set(pending.taskId, selection);
      void this.submitScheduledTask(pending.taskId, pending.request);
      return true;
    }

    if (/^n$/iu.test(trimmed)) {
      this.pendingRecallReview = null;
      this.approvedRecallSelections.set(pending.taskId, {
        authoritative: true,
        resolvedPreferences: [],
        relatedTaskIds: [],
        acceptedMemoryResources: [],
      });
      void this.submitScheduledTask(pending.taskId, pending.request);
      return true;
    }

    if (/^a$/iu.test(trimmed)) {
      this.persistAutoApplyPolicies(pending);
      this.pendingRecallReview = null;
      const selection = this.buildAcceptedRecallSelection(
        pending.preferenceCandidates,
        pending.taskCandidates,
      );
      this.approvedRecallSelections.set(pending.taskId, selection);
      this.appendOutput('→ 已记录后续自动采用策略，本次也将直接采用当前召回内容');
      void this.submitScheduledTask(pending.taskId, pending.request);
      return true;
    }

    const indexes = this.parseRecallSelectionInput(trimmed, pending.selectionItems.length);
    if (indexes) {
      const selectedPreferences: PreferenceMemoryCandidate[] = [];
      const selectedTasks: TaskMemoryCandidate[] = [];

      for (const index of indexes) {
        const item = pending.selectionItems[index - 1];
        if (!item) {
          continue;
        }

        if (item.kind === 'preference') {
          selectedPreferences.push(item.candidate);
        } else {
          selectedTasks.push(item.candidate);
        }
      }

      this.pendingRecallReview = null;
      this.approvedRecallSelections.set(
        pending.taskId,
        this.buildAcceptedRecallSelection(selectedPreferences, selectedTasks),
      );
      void this.submitScheduledTask(pending.taskId, pending.request);
      return true;
    }

    this.appendOutput('→ 当前有待确认的记忆召回，可输入 `y` / `n` / `s 编号...` / `a` / `r`。');
    return true;
  }

  private persistAutoApplyPolicies(pending: PendingRecallReview): void {
    const repo = new RecallReviewPolicyRepo(this.deps.db);
    const now = new Date().toISOString();
    const seenKeys = new Set<string>();

    const upsertPolicy = (policy: {
      id: string;
      policyType: 'task_memory' | 'project_preference' | 'contact_preference' | 'proposal_type';
      scope: string | null;
      subject: string | null;
      proposalType: GuidanceActionType | null;
    }) => {
      if (seenKeys.has(policy.id)) {
        return;
      }
      seenKeys.add(policy.id);
      repo.upsert({
        id: policy.id,
        policyType: policy.policyType,
        scope: policy.scope,
        subject: policy.subject,
        proposalType: policy.proposalType,
        autoApply: true,
        createdAt: now,
        updatedAt: now,
      });
    };

    if (pending.proposalType) {
      upsertPolicy({
        id: `policy:proposal:${pending.proposalType}`,
        policyType: 'proposal_type',
        scope: null,
        subject: null,
        proposalType: pending.proposalType,
      });
      return;
    }

    if (pending.taskCandidates.length > 0) {
      upsertPolicy({
        id: 'policy:task_memory:default',
        policyType: 'task_memory',
        scope: null,
        subject: null,
        proposalType: null,
      });
    }

    for (const candidate of pending.preferenceCandidates) {
      if (candidate.scope === 'project' && candidate.subject) {
        upsertPolicy({
          id: `policy:project:${candidate.subject}`,
          policyType: 'project_preference',
          scope: candidate.scope,
          subject: candidate.subject,
          proposalType: null,
        });
      }

      if (candidate.scope === 'contact' && candidate.subject) {
        upsertPolicy({
          id: `policy:contact:${candidate.subject}`,
          policyType: 'contact_preference',
          scope: candidate.scope,
          subject: candidate.subject,
          proposalType: null,
        });
      }
    }
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
    this.runtimeState = this.scheduler.getRuntimeState();
    this.notify();
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
        priorityHint: parsePriorityHint(userInput),
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
    this.pendingLastTaskConfirmation = {
      originalInput: userInput,
      completedTaskId: completedTask.id,
      unfinishedTaskId: unfinishedTask?.id ?? null,
    };
    this.appendLastTaskConfirmationBlock(this.pendingLastTaskConfirmation);
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

  private async handleNaturalLanguageInput(
    userInput: string,
    options: { skipRiskConfirmation?: boolean } = {},
  ): Promise<void> {
    if (await this.maybeHandlePersistedLastTaskContinuation(userInput)) {
      return;
    }

    if (this.pendingLastTaskConfirmation) {
      const handled = this.handlePendingLastTaskConfirmation(userInput);
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
      const handled = this.handlePendingRecallReview(userInput);
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
        await this.handleNaturalLanguageInput(pendingPrompt, { skipRiskConfirmation: true });
        return;
      }

      if (isRiskCancellationInstruction(userInput)) {
        this.pendingRiskConfirmation = null;
        this.appendOutput('→ 已取消高风险动作，不再继续执行');
        return;
      }

      this.appendOutput('⚠️ 当前有待确认的高风险动作。输入“确认执行”继续，或输入“取消执行”放弃。');
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

    if (!options.skipRiskConfirmation && isRiskyExternalActionInstruction(userInput)) {
      this.pendingRiskConfirmation = { prompt: userInput };
      this.appendOutput(
        '⚠️ 这是高风险动作，默认不会直接执行。',
        '→ 输入“确认执行”后继续，或输入“取消执行”放弃。',
      );
      return;
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
            priorityHint: parsePriorityHint(userInput),
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
          priorityHint: parsePriorityHint(userInput),
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
      await this.prepareTaskExecution(taskId, {
        userPrompt: userInput,
        contextTaskId: taskId,
        executionMode,
        schedulingReason: referencedTask.status === 'parked' ? '恢复已挂起任务' : '用户提交',
        priorityHint: parsePriorityHint(userInput),
      });
      return;
    }

    if (effectiveRoute === 'task_control') {
      this.appendOutput('未找到匹配的任务，可先用 /tasks 查看当前任务清单');
      return;
    }

    const inlineResources = extractInlineResourceMatches(userInput);
    const normalizedGoal = stripInlineResourceMatches(userInput, inlineResources) || userInput;
    const task = this.deps.taskEngine.create({
      title: normalizedGoal.slice(0, 50),
      goal: normalizedGoal,
      resources: inlineResources.map(resource => resource.resolvedPath),
    });
    taskId = task.id;
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
      schedulingReason: this.focusContext?.kind === 'conversation' && isConversationDerivedWorkInstruction(userInput)
        ? '按当前对话创建跟进任务'
        : buildSchedulingReason(userInput),
      priorityHint: parsePriorityHint(userInput),
    });
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
        this.appendOutput('请输入 `e <新内容>` 完成编辑后确认');
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

    this.appendOutput('→ 保留该候选偏好，稍后可输入 `y` / `n` / `e <新内容>`，或用 `/memory candidates` 管理');
    return false;
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
      priorityHint: request.priorityHint,
    });
    this.refreshRuntimeState();

    if (result.action === 'queued') {
      this.appendOutput(`→ 任务 #${taskId} 已进入待执行队列`);
      return;
    }

    if (result.action === 'preempted') {
      this.appendOutput(
        `→ 高优任务到达，抢占当前任务 #${result.preemptedTaskId}`,
        `→ 原因：${request.schedulingReason || '用户显式要求优先处理'}`,
        `→ 任务 #${result.preemptedTaskId} 已挂起，开始执行 #${taskId}`,
        `→ 派发给 ${this.deps.executor.name}...`,
      );
      return;
    }

    this.appendOutput(`→ 派发给 ${this.deps.executor.name}...`);
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
    const finishExecution = async (lines: string[]) => {
      this.refreshRuntimeState();
      this.appendOutput(...lines);
      await this.scheduler.scheduleNext();
      this.refreshRuntimeState();
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
    this.appendOutput(`→ 正在执行任务 #${taskId}...`);

    try {
      const currentTask = this.deps.taskEngine['taskRepo'].findById(taskId);
      if (!currentTask) {
        await finishExecution([`错误：任务不存在 ${taskId}`]);
        return;
      }

      if (currentTask.status !== 'running') {
        this.refreshRuntimeState();
        return;
      }

      this.ensureWorkspaceTargets(executionContextBundle.workspaceContext?.targetPaths ?? []);

      const result = await this.deps.executor.execute({
        task: this.deps.taskEngine['taskRepo'].findById(taskId)!,
        preferences,
        userPrompt,
        conversationHistory,
        executionContextBundle,
        onProgress: (event) => {
          const progressLine = `· #${taskId} ${event.text}`;
          if (this.lastProgressLineByTask.get(taskId) === progressLine) {
            return;
          }
          this.lastProgressLineByTask.set(taskId, progressLine);
          this.appendOutput(progressLine);
        },
      });

      const latestTask = this.deps.taskEngine['taskRepo'].findById(taskId);
      if (!latestTask || latestTask.status !== 'running') {
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
        this.deps.executor.name,
        new Date().toISOString(),
      );

      if (result.success) {
        const workspaceContext = executionContextBundle.workspaceContext;
        const artifactPaths = this.collectArtifactPaths(
          result.output,
          workspaceContext?.targetPaths ?? [],
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
            this.pendingPreferenceConfirmation = {
              observationId: observation.id,
              pattern,
            };
            completionLines.push(
              '',
              `💡 检测到重复模式（${observation.occurrenceCount}次）："${pattern}"`,
              '   要把它记为长期偏好吗？',
              '   [y] 确认  [n] 忽略  [e <新内容>] 编辑后确认',
              `   也可以稍后用 /memory confirm ${observation.id} 手动确认`,
            );
          }
        }

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
      if (this.blockTaskOnRecoverableFailure(taskId, errorMessage)) {
        await finishExecution([
          `✗ 执行失败: ${errorMessage}`,
          this.buildRecoverableFailureHint(taskId, errorMessage),
        ]);
        this.lastProgressLineByTask.delete(taskId);
        return;
      }

      this.deps.taskEngine.transition(taskId, 'parked');
      await finishExecution([`✗ 执行失败: ${errorMessage}`]);
      this.lastProgressLineByTask.delete(taskId);
    } catch (error) {
      const currentTask = this.deps.taskEngine['taskRepo'].findById(taskId);
      if (currentTask?.status === 'running') {
        const errorMessage = (error as Error).message;
        if (this.blockTaskOnRecoverableFailure(taskId, errorMessage)) {
          await finishExecution([
            `✗ 执行异常: ${errorMessage}`,
            this.buildRecoverableFailureHint(taskId, errorMessage),
          ]);
          this.lastProgressLineByTask.delete(taskId);
          return;
        }

        this.deps.taskEngine.transition(taskId, 'parked');
        await finishExecution([`✗ 执行异常: ${errorMessage}`]);
        this.lastProgressLineByTask.delete(taskId);
        return;
      }

      this.lastProgressLineByTask.delete(taskId);
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

  private buildRecoverableFailureHint(taskId: string, errorMessage: string): string {
    if (isPermissionFailure(errorMessage)) {
      return `→ 任务 #${taskId} 已转为阻塞，请先确认相关目录权限或系统授权；确认后执行 /task ${taskId} unblock，或直接说“已授权，继续刚才那个任务”`;
    }

    if (/执行器空闲超时|executor idle timeout/i.test(errorMessage)) {
      return `→ 任务 #${taskId} 已转为阻塞；执行器长时间没有输出或状态变化，可能卡住。请检查执行器是否仍在正常推进，必要时补充信息后执行 /task ${taskId} unblock 继续`;
    }

    if (/执行器运行总时长超限|executor max duration exceeded/i.test(errorMessage)) {
      return `→ 任务 #${taskId} 已转为阻塞；任务运行时间已超过总时长上限。若确认仍应继续，可调大 executor.max_duration 后执行 /task ${taskId} unblock 重试`;
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
      normalized = normalized.replace(/[：:，,\-]+$/u, '').trim();

      if (!normalized) {
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
    const startupCandidates = this.buildStartupResumeCandidates(recoveredRunningTasks);
    if (startupCandidates.length === 0) {
      return;
    }

    const startupPromise = (async () => {
      for (const task of startupCandidates) {
        const latestTask = this.deps.taskEngine['taskRepo'].findById(task.id);
        if (!latestTask || !['created', 'ready', 'parked'].includes(latestTask.status)) {
          continue;
        }

        this.appendOutput(
          latestTask.status === 'parked'
            ? `→ 启动后继续未完成任务 #${latestTask.id}`
            : `→ 启动后恢复待执行任务 #${latestTask.id}`,
        );
        await this.submitScheduledTask(latestTask.id, {
          userPrompt: latestTask.goal,
          contextTaskId: latestTask.id,
          executionMode: latestTask.status === 'parked' ? 'resume-parked' : 'fresh',
          schedulingReason: latestTask.status === 'parked'
            ? 'Metaclaw 重启后自动恢复未完成任务'
            : 'Metaclaw 重启后继续待执行任务',
        });
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
}

function createDefaultCommandRouter(): CommandRouter {
  const router = new CommandRouter();
  router.register(tasksCommand);
  router.register(taskCommand);
  router.register(memoryCommand);
  router.register(dashboardCommand);
  router.register(attachCommand);
  router.register(historyCommand);
  router.register(configCommand);
  router.register(helpCommand);
  router.register(exitCommand);
  return router;
}
