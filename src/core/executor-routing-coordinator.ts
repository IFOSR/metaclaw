import { ExecutionPlanningService, type ExecutionPlanV2 } from './execution-planning-service.js';
import type { ExecutorProfileService } from './executor-profile-service.js';
import type { ExecutorRouteDecision, IntentDecision } from './executor-router.js';
import type { IntentDecisionV2 } from './intent-orchestrator.js';
import type { SessionPersistenceService } from './session-persistence-service.js';
import type { TaskRuntimeService } from './task-runtime-service.js';
import type { Task } from './types.js';

export interface RoutedExecutorSelection {
  decision: ExecutorRouteDecision;
  executionPlan: ExecutionPlanV2;
  eventId: string;
  effectiveAction: ExecutorRouteDecision['action'];
}

export interface ExecutorRoutingCoordinatorDeps {
  profileService: ExecutorProfileService;
  taskRuntimeService: TaskRuntimeService;
  persistenceService: SessionPersistenceService;
  defaultExecutorName: string;
  executionPlanningService?: ExecutionPlanningService;
}

export interface ResolveExecutorForTaskInput {
  taskId: string | null;
  userInput: string;
  intentDecision?: IntentDecisionV2 | null;
  semanticDecision?: IntentDecision | null;
  fallbackTask?: Task;
}

export class ExecutorRoutingCoordinator {
  private readonly executionPlanningService: ExecutionPlanningService;

  constructor(private readonly deps: ExecutorRoutingCoordinatorDeps) {
    this.executionPlanningService = deps.executionPlanningService ?? new ExecutionPlanningService();
  }

  resolveForTask(input: ResolveExecutorForTaskInput): RoutedExecutorSelection {
    const profiles = this.deps.profileService.listProfiles();
    const task = input.taskId ? this.deps.taskRuntimeService.findTask(input.taskId) : null;
    const effectiveTask = task ?? input.fallbackTask;
    const taskExecutionPlan = task
      ? this.deps.taskRuntimeService.buildExecutionPlan(task, input.userInput)
      : {
          mode: 'blocked' as const,
          error: '缺少任务，无法生成执行计划',
        };
    if (!effectiveTask) {
      throw new Error('缺少任务，无法生成执行计划');
    }
    const executionPlan = this.executionPlanningService.plan({
      task: effectiveTask,
      userPrompt: input.userInput,
      taskExecutionPlan,
      intentDecision: input.intentDecision,
      semanticDecision: input.semanticDecision,
      executorProfiles: profiles,
      defaultExecutorName: this.deps.defaultExecutorName,
      resources: task?.resources ?? [],
    });
    const decision = executionPlan.routeDecision;
    const eventId = this.deps.persistenceService.recordRouteEvent({
      taskId: input.taskId,
      userInput: input.userInput,
      decision,
    });

    return {
      decision,
      executionPlan,
      eventId,
      effectiveAction: decision.action,
    };
  }

  formatRunLabel(plan: ExecutionPlanV2): string {
    if (plan.mode === 'race_executors') {
      return this.resolveRaceExecutorNames(plan).join('+');
    }
    return plan.selectedExecutor;
  }

  formatDisplayLabel(plan: ExecutionPlanV2): string {
    if (plan.mode === 'race_executors') {
      return this.resolveRaceExecutorNames(plan).join(' + ');
    }
    return plan.selectedExecutor;
  }

  formatRoutingDecision(routedExecutor: RoutedExecutorSelection): string[] {
    const reason = `${routedExecutor.decision.primaryIntent} / ${routedExecutor.decision.matchedBoundary.join(' + ') || routedExecutor.decision.reason}`;
    const planningLines = [
      `→ MetaClaw：执行计划：${routedExecutor.executionPlan.mode}；${routedExecutor.executionPlan.reason}`,
      routedExecutor.executionPlan.acceptanceCriteria.length > 0
        ? `→ MetaClaw：验收标准：${routedExecutor.executionPlan.acceptanceCriteria.map(criterion => criterion.id).join('、')}`
        : '→ MetaClaw：验收标准：无额外标准',
    ];
    if (routedExecutor.executionPlan.mode === 'race_executors') {
      return [
        `→ MetaClaw：路由决策：调研竞速 (${routedExecutor.effectiveAction}, confidence=${routedExecutor.decision.confidence.toFixed(2)})`,
        `→ MetaClaw：执行器：${this.formatDisplayLabel(routedExecutor.executionPlan)}`,
        `→ MetaClaw：原始首选：${routedExecutor.decision.selectedExecutor}；原因：${reason}`,
        ...planningLines,
      ];
    }

    return [
      `→ MetaClaw：路由决策：${routedExecutor.decision.selectedExecutor} (${routedExecutor.effectiveAction}, confidence=${routedExecutor.decision.confidence.toFixed(2)})`,
      `→ MetaClaw：原因：${reason}`,
      ...planningLines,
    ];
  }

  formatRaceDispatchLine(plan: ExecutionPlanV2): string {
    return `→ MetaClaw：调研竞速：同时派发给 ${this.formatDisplayLabel(plan)}；谁先返回采用谁的结果，并自动终止其他执行器`;
  }

  private resolveRaceExecutorNames(plan: ExecutionPlanV2): string[] {
    const researchExecutorNames = new Set<string>(
      [...plan.candidateExecutors, plan.selectedExecutor]
        .filter(name => name === 'pi-agent' || name === 'hermes-agent'),
    );
    const orderedResearchExecutors = ['pi-agent', 'hermes-agent']
      .filter(name => researchExecutorNames.has(name));

    if (orderedResearchExecutors.length > 0) {
      return orderedResearchExecutors;
    }

    return plan.candidateExecutors.length > 0 ? plan.candidateExecutors : [plan.selectedExecutor];
  }
}
