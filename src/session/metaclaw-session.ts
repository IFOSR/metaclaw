import type Database from 'better-sqlite3';
import type { Config, RuntimeState } from '../core/types.js';
import type { TaskEngine } from '../core/task-engine.js';
import type { MemoryEngine } from '../core/memory-engine.js';
import type { OrchestrationEngine } from '../core/orchestration.js';
import type { ExecutorAdapter } from '../executor/adapter.js';
import type { ContextRecaller } from '../core/context-recaller.js';
import type { LlmBridge } from '../core/llm-bridge.js';
import { SchedulerEngine } from '../core/scheduler.js';
import { ResumeContextBuilder } from '../core/resume-context-builder.js';
import { CommandRouter } from '../commands/router.js';
import { tasksCommand, taskCommand } from '../commands/task-commands.js';
import { memoryCommand } from '../commands/memory-commands.js';
import { dashboardCommand, attachCommand, historyCommand, configCommand, helpCommand, exitCommand } from '../commands/global-commands.js';
import { generateInteractionId } from '../utils/id.js';
import {
  buildSchedulingReason,
  extractPatterns,
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

export class MetaclawSession {
  private output: string[] = [];
  private currentTaskId: string | null = null;
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
      async (taskId: string) => this.dispatchTask(taskId),
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

    this.initialized = true;
    this.refreshRuntimeState();
    this.notify();
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

    const recentTasks = this.deps.taskEngine.list().map(task => ({
      id: task.id,
      title: task.title,
      goal: task.goal,
      summary: task.summary,
    }));
    const intent = await this.deps.llmBridge.resolveIntent(userInput, recentTasks);

    let taskId: string;
    if (intent.type === 'reference' && intent.taskId) {
      const referencedTask = this.deps.taskEngine['taskRepo'].findById(intent.taskId);
      if (!referencedTask) {
        throw new Error(`任务不存在: ${intent.taskId}`);
      }

      const plan = planTaskExecution(referencedTask, userInput);
      if (plan.mode === 'blocked') {
        this.appendOutput(`错误：${plan.error}`);
        return;
      }

      if (plan.mode === 'fork-follow-up') {
        const followUpTask = this.deps.taskEngine.create(plan.newTaskInput);
        taskId = followUpTask.id;
        this.setCurrentTaskId(taskId);
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
      this.appendOutput(`→ 关联到任务 #${taskId}`);
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

    const task = this.deps.taskEngine.create({
      title: userInput.slice(0, 50),
      goal: userInput,
    });
    taskId = task.id;
    this.setCurrentTaskId(taskId);
    this.appendOutput(`任务 #${taskId} 已创建：${task.title}`);

    await this.submitScheduledTask(taskId, {
      userPrompt: userInput,
      contextTaskId: taskId,
      executionMode: 'fresh',
      schedulingReason: buildSchedulingReason(userInput),
      priorityHint: parsePriorityHint(userInput),
    });
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

  private dispatchTask(taskId: string): Promise<void> {
    const dispatchPromise = (async () => {
      const request = this.queuedExecution.get(taskId);
      if (!request) return;
      await this.executeTask(taskId, request);
    })();

    this.activeDispatches.add(dispatchPromise);
    void dispatchPromise.finally(() => {
      this.activeDispatches.delete(dispatchPromise);
      this.notify();
    });

    return dispatchPromise;
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

    const conversationHistory = await this.deps.contextRecaller.recallAsync({
      taskId: contextTaskId,
      sessionId: this.deps.sessionId,
      userInput: userPrompt,
    });
    const executionContextBundle = await this.resumeContextBuilder.build({
      taskId,
      mode: executionMode,
      userInput: userPrompt,
      sessionId: this.deps.sessionId,
      schedulingReason,
      newlyProvidedResources,
    });

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
        return;
      }

      this.deps.taskEngine.transition(taskId, 'parked');
      await finishExecution([`✗ 执行失败: ${result.error || '未知错误'}`]);
    } catch (error) {
      const currentTask = this.deps.taskEngine['taskRepo'].findById(taskId);
      if (currentTask?.status === 'running') {
        this.deps.taskEngine.transition(taskId, 'parked');
        await finishExecution([`✗ 执行异常: ${(error as Error).message}`]);
        return;
      }

      this.refreshRuntimeState();
    }
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
