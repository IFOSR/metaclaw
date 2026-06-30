import type { IntentDecisionV2 } from '../core/intent-orchestrator.js';
import type { TaskSemanticService } from './task-semantic-service.js';
import type { TaskRuntimeService } from './task-runtime-service.js';
import type { TaskSummary } from '../core/llm-bridge.js';
import type { Task } from '../core/types.js';
import { filterDurableTasks } from '../core/task-routing.js';
import { reconcileBlockedTasksFromInput } from './blocked-task-reconciler.js';
import {
  isContinuePreviousTaskInstruction,
  isResumeReferenceInstruction,
} from '../session/session-helpers.js';
import type { TaskExecutionPlan } from './task-execution-planner.js';

export type ResumePlanResult =
  | { action: 'not_handled' }
  | { action: 'message'; lines: string[] }
  | {
      action: 'execute_existing';
      task: Task;
      plan: Extract<TaskExecutionPlan, { mode: 'reuse-existing' }>;
      lines: string[];
      observeResumeIntent?: boolean;
      schedulingReason: string;
      executionMode: 'fresh' | 'resume-parked';
    }
  | {
      action: 'unblock_and_execute';
      task: Task;
      blockedReason: string | null;
      lines: string[];
      schedulingReason: string;
      triggerReason: string;
      newlyProvidedResources?: string[];
      triggerKind?: 'explicit-task-command' | 'natural-language-resume' | 'user-query-unblocked';
      observeResumeIntent?: boolean;
    }
  | {
      action: 'fork_follow_up';
      sourceTask: Task;
      plan: Extract<TaskExecutionPlan, { mode: 'fork-follow-up' }>;
      lines: string[];
      schedulingReason: string;
    };

export class TaskResumePlanner {
  constructor(
    private readonly deps: {
      taskRuntimeService: TaskRuntimeService;
      taskSemanticService: TaskSemanticService;
      sessionStateRepo: { get(): { lastFocusedTaskId: string | null; lastCompletedTaskId: string | null } | null };
    },
  ) {}

  planReferencedTask(input: {
    userInput: string;
    referencedTask: Task;
    intentDecision: IntentDecisionV2;
  }): ResumePlanResult {
    const { userInput, referencedTask, intentDecision } = input;
    const plan = this.deps.taskRuntimeService.buildExecutionPlan(referencedTask, userInput);
    if (plan.mode === 'blocked') {
      const blockedReason = this.getWaitingBlockReason(referencedTask);
      const explicitlyRequestedBlockedResume = intentDecision.task.binding === 'reference'
        && intentDecision.task.taskId === referencedTask.id
        && (intentDecision.task.control === 'resume_task' || intentDecision.task.control === 'recover_blocked');
      if (blockedReason && explicitlyRequestedBlockedResume) {
        return {
          action: 'unblock_and_execute',
          task: referencedTask,
          blockedReason,
          lines: [
            `→ 关联到任务 #${referencedTask.id}`,
            `→ 任务 #${referencedTask.id} 已解除阻塞，继续执行`,
          ],
          schedulingReason: '网络已恢复，继续之前阻塞任务',
          triggerReason: '用户显式引用旧阻塞任务并说明可继续',
          triggerKind: 'explicit-task-command',
          observeResumeIntent: true,
        };
      }

      return { action: 'message', lines: [`错误：${plan.error}`] };
    }

    if (plan.mode === 'fork-follow-up') {
      return {
        action: 'fork_follow_up',
        sourceTask: referencedTask,
        plan,
        lines: [
          `→ 关联到任务 #${referencedTask.id}`,
          '→ 已完成任务不可直接重跑',
        ],
        schedulingReason: '跟进任务恢复',
      };
    }

    if (referencedTask.status === 'running' && isResumeReferenceInstruction(userInput)) {
      return {
        action: 'message',
        lines: [`→ 任务 #${plan.executionTaskId} 已在执行中，无需再次排队`],
      };
    }

    return {
      action: 'execute_existing',
      task: referencedTask,
      plan,
      lines: [referencedTask.status === 'parked'
        ? `→ 命中已有挂起任务 #${plan.executionTaskId}`
        : `→ 关联到任务 #${plan.executionTaskId}`],
      observeResumeIntent: referencedTask.status === 'parked',
      schedulingReason: referencedTask.status === 'parked' ? '恢复已挂起任务' : '用户提交',
      executionMode: referencedTask.status === 'parked' ? 'resume-parked' : 'fresh',
    };
  }

  async planLastTaskContinuation(userInput: string): Promise<ResumePlanResult> {
    if (!isContinuePreviousTaskInstruction(userInput)) {
      return { action: 'not_handled' };
    }

    const state = this.deps.sessionStateRepo.get();
    if (!state) {
      return this.planLegacyOrNaturalLanguageResume(userInput);
    }

    const lastFocusedTask = state.lastFocusedTaskId
      ? this.deps.taskRuntimeService.findTask(state.lastFocusedTaskId)
      : null;
    const lastCompletedTask = state.lastCompletedTaskId
      ? this.deps.taskRuntimeService.findTask(state.lastCompletedTaskId)
      : null;
    const targetTask = lastFocusedTask ?? lastCompletedTask;
    if (!targetTask) {
      return this.planLegacyOrNaturalLanguageResume(userInput);
    }

    if (['created', 'ready', 'running', 'parked', 'blocked'].includes(targetTask.status)) {
      const plan = this.deps.taskRuntimeService.buildExecutionPlan(targetTask, userInput);
      if (plan.mode === 'blocked') {
        return { action: 'message', lines: [`错误：${plan.error}`] };
      }
      if (plan.mode === 'fork-follow-up') {
        return { action: 'not_handled' };
      }
      return {
        action: 'execute_existing',
        task: targetTask,
        plan,
        lines: [`→ 命中上次任务指针 #${targetTask.id}`],
        observeResumeIntent: targetTask.status === 'parked',
        schedulingReason: targetTask.status === 'parked' ? '恢复上一个任务' : '继续上一个任务',
        executionMode: targetTask.status === 'parked' ? 'resume-parked' : 'fresh',
      };
    }

    const completedTask = lastFocusedTask && ['done', 'archived', 'cancelled'].includes(lastFocusedTask.status)
      ? lastFocusedTask
      : lastCompletedTask;
    if (!completedTask) {
      return { action: 'not_handled' };
    }

    const unfinishedTask = this.findMostRecentUnfinishedTask([completedTask.id]);
    if (unfinishedTask) {
      const plan = this.deps.taskRuntimeService.buildExecutionPlan(unfinishedTask, userInput);
      if (plan.mode === 'reuse-existing') {
        return {
          action: 'execute_existing',
          task: unfinishedTask,
          plan,
          lines: [
            ...this.buildLastTaskAutoDecisionBlock(completedTask, unfinishedTask),
            `→ 改为恢复最近未完成任务 #${unfinishedTask.id}`,
          ],
          observeResumeIntent: unfinishedTask.status === 'parked',
          schedulingReason: unfinishedTask.status === 'parked' ? '恢复最近未完成任务' : '继续最近未完成任务',
          executionMode: unfinishedTask.status === 'parked' ? 'resume-parked' : 'fresh',
        };
      }
    }

    const followUpPlan = this.deps.taskRuntimeService.buildExecutionPlan(completedTask, userInput);
    if (followUpPlan.mode !== 'fork-follow-up') {
      return { action: 'not_handled' };
    }
    return {
      action: 'fork_follow_up',
      sourceTask: completedTask,
      plan: followUpPlan,
      lines: [
        ...this.buildLastTaskAutoDecisionBlock(completedTask, null),
        `→ 基于上一个已完成任务 #${completedTask.id} 创建 follow-up 任务`,
      ],
      schedulingReason: '基于上次已完成任务继续',
    };
  }

  private async planLegacyOrNaturalLanguageResume(userInput: string): Promise<ResumePlanResult> {
    const candidates = filterDurableTasks(this.deps.taskRuntimeService.listTasks());
    if (!this.deps.taskSemanticService.hasTaskResumeResolver() && this.deps.taskSemanticService.hasLegacyResumeResolver()) {
      const { intent } = await this.deps.taskSemanticService.resolveLegacyResumeIntent(
        userInput,
        candidates.map(task => ({
          id: task.id,
          title: task.title,
          goal: task.goal,
          summary: task.summary,
          status: task.status,
        })),
      );
      if (intent?.type === 'reference' && intent.taskId) {
        const targetTask = this.deps.taskRuntimeService.findTask(intent.taskId);
        if (targetTask) {
          return this.planReferencedTask({
            userInput,
            referencedTask: targetTask,
            intentDecision: {
              interactionType: 'task_control',
              confidence: 0.7,
              reason: intent.reason,
              clarificationQuestion: null,
              risk: { level: 'low', requiresConfirmation: false, reasons: [intent.reason] },
              task: {
                binding: 'reference',
                taskId: targetTask.id,
                control: 'resume_task',
                scope: null,
              },
              execution: {
                mode: 'none',
                complexity: 'simple',
                selectedExecutor: null,
                candidateExecutors: [],
                requiresVerification: false,
                canModifyFiles: false,
                requiresExternalGateway: false,
                capabilityClass: 'conversation',
                matchedBoundary: [],
              },
              hints: [],
            },
          });
        }
      }
    }

    return this.planNaturalLanguageResume(userInput);
  }

  async planNaturalLanguageResume(userInput: string): Promise<ResumePlanResult> {
    const candidates = filterDurableTasks(this.deps.taskRuntimeService.listTasks())
      .filter(task => task.status === 'parked' || task.status === 'blocked' || task.status === 'running');
    if (candidates.length === 0) {
      return { action: 'message', lines: ['当前没有可恢复或正在执行的任务'] };
    }

    const decision = await this.deps.taskSemanticService.decideResumeTarget(
      userInput,
      candidates.map(task => this.toTaskSummary(task)),
      { action: 'none' as const, taskId: null, reason: 'LLM resume intent 超时，fallback', confidence: 0 },
    );

    if (decision.action !== 'resume' || !decision.taskId || decision.confidence < 0.6) {
      const fallback = candidates[0];
      if (fallback.status === 'running' && isResumeReferenceInstruction(userInput)) {
        return { action: 'message', lines: [`→ 任务 #${fallback.id} 已在执行中，无需再次排队`] };
      }
      return { action: 'message', lines: ['未找到匹配的任务，可先用 /tasks 查看当前任务清单'] };
    }

    const targetTask = this.deps.taskRuntimeService.findTask(decision.taskId);
    if (!targetTask || (targetTask.status !== 'parked' && targetTask.status !== 'blocked')) {
      return { action: 'not_handled' };
    }

    const plan = this.deps.taskRuntimeService.buildExecutionPlan(targetTask, userInput);
    if (plan.mode === 'blocked') {
      return {
        action: 'unblock_and_execute',
        task: targetTask,
        blockedReason: this.getWaitingBlockReason(targetTask),
        lines: [
          `→ 命中已有阻塞任务 #${targetTask.id}`,
          `→ 语义判断：${decision.reason} (confidence=${decision.confidence.toFixed(2)})`,
          `→ 任务 #${targetTask.id} 已解除阻塞，继续执行`,
        ],
        schedulingReason: '自然语言恢复阻塞任务',
        triggerReason: decision.reason || '自然语言判断为继续旧阻塞任务',
        triggerKind: 'natural-language-resume',
      };
    }

    if (plan.mode === 'fork-follow-up') {
      return { action: 'not_handled' };
    }

    return {
      action: 'execute_existing',
      task: targetTask,
      plan,
      lines: [
        `→ 命中已有${targetTask.status === 'parked' ? '挂起' : '未完成'}任务 #${targetTask.id}`,
        `→ 语义判断：${decision.reason} (confidence=${decision.confidence.toFixed(2)})`,
      ],
      observeResumeIntent: false,
      schedulingReason: targetTask.status === 'parked' ? '自然语言恢复挂起任务' : '自然语言继续已有任务',
      executionMode: targetTask.status === 'parked' ? 'resume-parked' : 'fresh',
    };
  }

  planBlockedRecovery(userInput: string): ResumePlanResult {
    const durableTasks = filterDurableTasks(this.deps.taskRuntimeService.listTasks());
    const blockedTasks = durableTasks.filter(task => task.status === 'blocked');
    const decision = reconcileBlockedTasksFromInput(durableTasks, userInput) ?? (blockedTasks.length === 1
      ? {
          task: blockedTasks[0],
          reason: '统一意图裁决判断为恢复阻塞任务',
          newlyProvidedResources: [],
        }
      : null);
    if (!decision) {
      return { action: 'message', lines: ['未找到可恢复的阻塞任务，可先用 /tasks 查看当前任务清单'] };
    }

    return {
      action: 'unblock_and_execute',
      task: decision.task,
      blockedReason: this.getWaitingBlockReason(decision.task),
      newlyProvidedResources: decision.newlyProvidedResources,
      lines: [
        `→ 检测到任务 #${decision.task.id} 的阻塞条件已满足`,
        `→ 原因：${decision.reason}`,
        decision.newlyProvidedResources.length > 0
          ? `→ 已自动关联 ${decision.newlyProvidedResources.length} 份补充材料`
          : `→ 任务 #${decision.task.id} 已解除阻塞，继续执行`,
      ],
      schedulingReason: `阻塞条件已满足：${decision.reason}`,
      triggerReason: decision.reason,
      triggerKind: 'user-query-unblocked',
    };
  }

  private findMostRecentUnfinishedTask(excludeTaskIds: string[] = []): Task | null {
    const excluded = new Set(excludeTaskIds);
    return this.deps.taskRuntimeService.listTasks().find(task =>
      !excluded.has(task.id) && ['created', 'ready', 'running', 'parked', 'blocked'].includes(task.status)
    ) ?? null;
  }

  private buildLastTaskAutoDecisionBlock(completedTask: Task, unfinishedTask: Task | null): string[] {
    return [
      '',
      '┌─ 上次任务自动处理 ───────────────────────────────┐',
      `│ 上一个任务：#${completedTask.id} ${completedTask.title}`,
      '│ 上一个任务已完成。',
      unfinishedTask
        ? `│ 自动决策：恢复最近未完成任务 #${unfinishedTask.id} ${unfinishedTask.title}`
        : '│ 自动决策：基于上一个任务创建 follow-up',
      '│ 策略：无需用户确认；优先恢复未完成任务，否则创建跟进任务',
      '└──────────────────────────────────────────────────┘',
    ];
  }

  private toTaskSummary(task: Task): TaskSummary {
    return {
      id: task.id,
      title: task.title,
      goal: task.goal,
      summary: task.summary || task.snapshots.at(-1)?.nextStep || task.lastInterruptionReason,
      status: task.status,
    };
  }

  private getWaitingBlockReason(task: Task): string | null {
    return task.dependencies.find(dependency => dependency.status === 'waiting')?.description ?? null;
  }
}
