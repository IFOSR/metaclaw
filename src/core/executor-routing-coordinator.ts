// Executor routing coordinator that binds session tasks to routing policies and route events.
import { buildRouteDecisionFromPolicy } from '../routing/execution-policy-planner.js';
import { ExecutionPlanningService } from './execution-planning-service.js';
import type { ExecutionPolicy } from './execution-policy.js';
import type { ExecutorProfileService } from '../executor/executor-profile-service.js';
import type { ExecutorRouteDecision, IntentDecision } from './executor-router.js';
import type { IntentDecisionV2 } from './intent-orchestrator.js';
import type { SessionPersistenceService } from '../session/session-persistence-service.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { Task } from './types.js';

export interface RoutedExecutorSelection {
  decision: ExecutorRouteDecision;
  executionPolicy: ExecutionPolicy;
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
          error: 'missing task; cannot build an execution plan',
        };
    if (!effectiveTask) {
      throw new Error('missing task; cannot build an execution plan');
    }

    const executionPolicy = this.executionPlanningService.plan({
      task: effectiveTask,
      userPrompt: input.userInput,
      taskExecutionPlan,
      intentDecision: input.intentDecision,
      semanticDecision: input.semanticDecision,
      executorProfiles: profiles,
      defaultExecutorName: this.deps.defaultExecutorName,
      resources: task?.resources ?? [],
    });
    const decision = buildRouteDecisionFromPolicy(executionPolicy);
    const eventId = this.deps.persistenceService.recordRouteEvent({
      taskId: input.taskId,
      userInput: input.userInput,
      decision,
    });

    return {
      decision,
      executionPolicy,
      eventId,
      effectiveAction: decision.action,
    };
  }

  formatRunLabel(policy: ExecutionPolicy): string {
    return policy.primaryExecutor;
  }

  formatDisplayLabel(policy: ExecutionPolicy): string {
    return policy.primaryExecutor;
  }

  formatRoutingDecision(routedExecutor: RoutedExecutorSelection): string[] {
    const reason = `${routedExecutor.decision.primaryIntent} / ${routedExecutor.decision.matchedBoundary.join(' + ') || routedExecutor.decision.reason}`;
    const planningLines = [
      `-> MetaClaw: execution policy: ${routedExecutor.executionPolicy.mode}; ${routedExecutor.executionPolicy.reason}`,
      routedExecutor.executionPolicy.acceptanceCriteria.length > 0
        ? `-> MetaClaw: acceptance criteria: ${routedExecutor.executionPolicy.acceptanceCriteria.map(criterion => criterion.id).join(', ')}`
        : '-> MetaClaw: acceptance criteria: none',
    ];

    return [
      `-> MetaClaw: route decision: ${routedExecutor.decision.selectedExecutor} (${routedExecutor.effectiveAction}, confidence=${routedExecutor.decision.confidence.toFixed(2)})`,
      `-> MetaClaw: reason: ${reason}`,
      ...planningLines,
    ];
  }
}
