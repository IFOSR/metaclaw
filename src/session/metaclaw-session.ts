import type Database from 'better-sqlite3';
import { existsSync } from 'fs';
import type { Config, RuntimeState } from '../core/types.js';
import type { Task } from '../core/types.js';
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
import { CommandRouter } from '../commands/router.js';
import { tasksCommand, taskCommand } from '../commands/task-commands.js';
import { memoryCommand } from '../commands/memory-commands.js';
import { dashboardCommand, attachCommand, historyCommand, configCommand, helpCommand, exitCommand } from '../commands/global-commands.js';
import { generateInteractionId } from '../utils/id.js';
import { isPermissionFailure, isRecoverableExecutorFailure } from '../executor/error-utils.js';
import {
  buildSchedulingReason,
  extractPatterns,
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

  constructor(private deps: MetaclawSessionDeps) {
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
        await this.submitScheduledTask(resumedTask.id, {
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
          await this.submitScheduledTask(referencedTask.id, {
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
        await this.submitScheduledTask(taskId, {
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
      await this.submitScheduledTask(taskId, {
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

    await this.submitScheduledTask(taskId, {
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
    const preferences = this.deps.memoryEngine.recall({ taskId, keywords, userInput: userPrompt });

    this.appendOutput(`→ 正在回忆任务 #${taskId} 的上下文...`);
    const conversationHistory = await this.deps.contextRecaller.recallAsync({
      taskId: contextTaskId,
      sessionId: this.deps.sessionId,
      userInput: userPrompt,
    });
    this.appendOutput(`→ 已召回 ${conversationHistory.length} 条相关上下文`);

    this.appendOutput(`→ 正在构建任务 #${taskId} 的执行上下文...`);
    const executionContextBundle = await this.resumeContextBuilder.build({
      taskId,
      mode: executionMode,
      userInput: userPrompt,
      sessionId: this.deps.sessionId,
      schedulingReason,
      newlyProvidedResources,
    });
    this.appendOutput('→ 执行上下文已准备完成');
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
        const artifactPaths = this.collectArtifactPaths(
          result.output,
          executionContextBundle.workspaceContext?.targetPaths ?? [],
        );
        this.deps.taskEngine['taskRepo'].update(taskId, {
          summary: result.output.slice(0, 200),
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
        const suggestion = this.deps.orchestration.suggestNext(taskId);
        completionLines.push(
          `✓ 任务完成 (${(result.durationMs / 1000).toFixed(1)}s)`,
          '',
          '┌─ 任务结果 ───────────────────────────────────────┐',
          `│ 摘要: ${result.output.slice(0, 200) || '无'}`,
          `│ 下一步: ${this.buildCompletionNextStep(suggestion)}`,
          '└──────────────────────────────────────────────────┘',
          '',
          result.output,
        );
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

  private setFocusContext(focus: FocusContext | null): void {
    this.focusContext = focus;
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
