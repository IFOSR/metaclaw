import type Database from 'better-sqlite3';
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
  isConversationalContinuationInstruction,
  isExplicitTaskControlReference,
  isRecoverableBlockedResumeInstruction,
  isResumeReferenceInstruction,
  parseExplicitRemember,
  parsePriorityHint,
  planTaskExecution,
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
}

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

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
  private initialized = false;
  private listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private queuedExecution = new Map<string, QueuedExecutionRequest>();
  private activeDispatches = new Set<Promise<void>>();
  private lastProgressLineByTask = new Map<string, string>();
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

  private notify(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach(listener => listener(snapshot));
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

  private async handleNaturalLanguageInput(userInput: string): Promise<void> {
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

    const durableTasks = filterDurableTasks(this.deps.taskEngine.list());
    const recentTasks = durableTasks.map(task => ({
      id: task.id,
      title: task.title,
      goal: task.goal,
      summary: task.summary,
      status: task.status,
    }));
    const llmRouteDecision = typeof this.deps.llmBridge.resolveRoute === 'function'
      ? await this.deps.llmBridge.resolveRoute(userInput, recentTasks)
      : { route: 'unknown', reason: '缺少 resolveRoute，fallback' as const };
    let route: 'conversation' | 'task_control' | 'durable_task';
    if (llmRouteDecision.route === 'unknown') {
      route = classifyNaturalLanguageInput(userInput, durableTasks);
    } else {
      route = llmRouteDecision.route as 'conversation' | 'task_control' | 'durable_task';
    }
    const effectiveRoute = this.applyFocusAwareRouteOverride(userInput, route);

    if (effectiveRoute === 'conversation') {
      await this.handleConversationInput(userInput);
      return;
    }

    if (effectiveRoute === 'task_control' && recentTasks.length === 0) {
      this.appendOutput('当前没有可操作的任务');
      return;
    }

    const intent = await this.deps.llmBridge.resolveIntent(userInput, recentTasks);

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

    const task = this.deps.taskEngine.create({
      title: userInput.slice(0, 50),
      goal: userInput,
    });
    taskId = task.id;
    this.setCurrentTaskId(taskId);
    this.setFocusContext({ kind: 'task', taskId });
    this.appendOutput(`任务 #${taskId} 已创建：${task.title}`);

    await this.submitScheduledTask(taskId, {
      userPrompt: userInput,
      contextTaskId: taskId,
      executionMode: 'fresh',
      schedulingReason: buildSchedulingReason(userInput),
      priorityHint: parsePriorityHint(userInput),
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

    const keywords = userPrompt.split(/\s+/).filter(word => word.length > 2);
    const preferences = this.deps.memoryEngine.recall({ taskId, keywords });
    if (preferences.length > 0) {
      for (const preference of preferences) {
        this.deps.memoryEngine.recordUsage(preference.id, taskId);
      }
      this.appendOutput(
        `→ 已注入 ${preferences.length} 条偏好`,
        ...preferences.map(preference => `  - [${preference.scope}] ${preference.content}`),
      );
    }

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
        this.deps.taskEngine['taskRepo'].update(taskId, {
          summary: result.output.slice(0, 200),
          injectedPreferences: preferences.map(preference => preference.id),
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
              `   要记为长期偏好吗？输入 /memory confirm ${observation.id}`,
            );
          }
        }

        this.deps.taskEngine.transition(taskId, 'done');
        completionLines.push(
          `✓ 任务完成 (${(result.durationMs / 1000).toFixed(1)}s)`,
          '',
          result.output,
        );

        const suggestion = this.deps.orchestration.suggestNext(taskId);
        if (suggestion) {
          completionLines.push('', `💡 建议：${suggestion.recommendedAction}`);
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

  private setFocusContext(focus: FocusContext | null): void {
    this.focusContext = focus;
  }

  private applyFocusAwareRouteOverride(
    userInput: string,
    route: 'conversation' | 'task_control' | 'durable_task',
  ): 'conversation' | 'task_control' | 'durable_task' {
    if (
      this.focusContext?.kind === 'conversation'
      && route === 'task_control'
      && isConversationalContinuationInstruction(userInput)
      && !isExplicitTaskControlReference(userInput)
    ) {
      return 'conversation';
    }

    return route;
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
