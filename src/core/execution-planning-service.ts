import type { ExecutionPlan } from '../session/session-helpers.js';
import type {
  ExecutionStrategy,
  ExecutionWorkUnit,
  AcceptanceCriterion,
} from './execution-strategy-planner.js';
import { ExecutionStrategyPlanner } from './execution-strategy-planner.js';
import {
  ExecutorRouter,
  buildFallbackIntentDecision,
  type ExecutorProfile,
  type ExecutorRouteDecision,
  type IntentDecision,
} from './executor-router.js';
import type { ExecutionContextBundleV2, ResolvedPreference, Task } from './types.js';
import type { WorkUnitResult } from './multi-executor-orchestrator.js';
import type { IntentDecisionV2 } from './intent-orchestrator.js';

export type ExecutionPlanModeV2 = 'single_executor' | 'race_executors' | 'multi_executor';

export interface ExecutionPlanningInput {
  task: Task;
  userPrompt: string;
  taskExecutionPlan: ExecutionPlan;
  intentDecision?: IntentDecisionV2 | null;
  semanticDecision?: IntentDecision | null;
  executorProfiles: ExecutorProfile[];
  defaultExecutorName: string;
  resources: string[];
  recalledTaskIds?: string[];
}

export interface ExecutionPlanV2 {
  taskId: string;
  mode: ExecutionPlanModeV2;
  reason: string;
  selectedExecutor: string;
  candidateExecutors: string[];
  routeDecision: ExecutorRouteDecision;
  strategy: ExecutionStrategy;
  workUnits: ExecutionWorkUnit[];
  acceptanceCriteria: AcceptanceCriterion[];
  requiresVerification: boolean;
}

export interface ExecutionResult {
  taskId: string;
  executionId: string;
  status: 'success' | 'failed' | 'blocked' | 'cancelled';
  executorName: string;
  output: string;
  error: string | null;
  artifacts: string[];
  workUnitResults: WorkUnitResult[];
  durationMs: number;
  userPrompt: string;
  preferences: ResolvedPreference[];
  context: ExecutionContextBundleV2;
  recovery: {
    recoverable: boolean;
    blockReason: string | null;
  };
  runtime: {
    raceExecutors: string[];
    abortedExecutors: string[];
    fallbackReason: string | null;
    fallbackLines: string[];
  };
}

export class ExecutionPlanningService {
  constructor(private readonly strategyPlanner = new ExecutionStrategyPlanner()) {}

  plan(input: ExecutionPlanningInput): ExecutionPlanV2 {
    const routeDecision = this.routeExecutor(input);
    const strategy = this.strategyPlanner.plan({
      task: input.task,
      userPrompt: input.userPrompt,
      executionPlan: input.taskExecutionPlan,
      routeDecision,
      retrievedTasks: (input.recalledTaskIds ?? []).map(taskId => ({
        taskId,
        score: 1,
        recallMode: 'related' as const,
        sources: [{
          kind: 'explicit' as const,
          sourceId: taskId,
          snippet: 'approved recall selection',
        }],
        artifacts: [],
        pitfalls: [],
        reason: 'approved recall selection',
      })),
      resources: input.resources,
    });
    const mode = this.resolveMode(routeDecision, strategy);
    const workUnits = strategy.mode === 'multi_executor' ? strategy.workUnits : [];
    const acceptanceCriteria = strategy.mode === 'multi_executor'
      ? strategy.aggregation.criteria
      : this.buildSingleExecutorAcceptance(input, routeDecision);

    return {
      taskId: input.task.id,
      mode,
      reason: strategy.reason,
      selectedExecutor: routeDecision.selectedExecutor,
      candidateExecutors: routeDecision.candidates.map(candidate => candidate.executorName),
      routeDecision,
      strategy,
      workUnits,
      acceptanceCriteria,
      requiresVerification: mode !== 'single_executor' || acceptanceCriteria.some(criterion => criterion.severity === 'must'),
    };
  }

  private routeExecutor(input: ExecutionPlanningInput): ExecutorRouteDecision {
    const semanticDecision = input.semanticDecision
      ?? (input.intentDecision ? this.buildIntentDecisionFromV2(input.intentDecision, input.defaultExecutorName) : null)
      ?? buildFallbackIntentDecision({
      target: input.defaultExecutorName,
      action: 'ask_clarification',
      primaryIntent: 'general',
      capabilityClass: 'general',
      confidence: 0.4,
      reason: '缺少顶层语义裁决，不能用自然语言 fallback 直接派发',
    });

    return new ExecutorRouter(input.executorProfiles).route({
      decision: semanticDecision,
      defaultExecutorName: input.defaultExecutorName,
    });
  }

  private buildIntentDecisionFromV2(decision: IntentDecisionV2, defaultExecutorName: string): IntentDecision {
    const target = decision.execution.selectedExecutor
      ?? decision.execution.candidateExecutors[0]
      ?? defaultExecutorName;
    const primaryIntent = decision.execution.primaryIntent ?? this.inferTaskRouteIntent(decision);
    const action = decision.execution.mode === 'race_executors'
      ? 'race_executors'
      : decision.risk.requiresConfirmation
        ? 'ask_review'
        : 'auto_dispatch';

    return buildFallbackIntentDecision({
      target,
      action,
      primaryIntent,
      capabilityClass: primaryIntent,
      matchedBoundary: [
        ...(decision.execution.matchedBoundary && decision.execution.matchedBoundary.length > 0
          ? decision.execution.matchedBoundary
          : [primaryIntent]),
        ...decision.hints.map(hint => hint.kind),
      ],
      requiredCapabilities: decision.hints.map(hint => hint.kind),
      confidence: decision.confidence,
      reason: decision.reason,
      riskLevel: decision.risk.level,
      needsLongRunningTask: decision.interactionType === 'durable_task' || decision.interactionType === 'executor_dispatch',
      requiresLocalRepo: decision.execution.canModifyFiles,
      requiresResearch: primaryIntent === 'research_workflow',
      requiresMultiTool: decision.execution.mode === 'multi_executor' || decision.execution.mode === 'race_executors',
      requiresLongTermMemory: decision.hints.some(hint => hint.kind === 'resource_reference'),
      requiresExternalGateway: decision.execution.requiresExternalGateway,
      canModifyFiles: decision.execution.canModifyFiles,
      shouldCreateDurableTask: decision.task.binding === 'new' || decision.interactionType === 'durable_task',
    });
  }

  private inferTaskRouteIntent(decision: IntentDecisionV2): IntentDecision['route']['primaryIntent'] {
    if (decision.execution.requiresExternalGateway) {
      return 'memory_agent_ops';
    }
    if (decision.execution.canModifyFiles) {
      return 'repo_execution';
    }
    if (decision.execution.mode === 'multi_executor' || decision.execution.mode === 'race_executors') {
      return 'research_workflow';
    }
    return 'general';
  }

  private resolveMode(routeDecision: ExecutorRouteDecision, strategy: ExecutionStrategy): ExecutionPlanModeV2 {
    if (strategy.mode === 'multi_executor') {
      return 'multi_executor';
    }

    if (routeDecision.action === 'race_executors') {
      return 'race_executors';
    }

    if (routeDecision.primaryIntent === 'research_workflow' || routeDecision.primaryIntent === 'memory_agent_ops') {
      const researchCandidateCount = routeDecision.candidates
        .filter(candidate => candidate.executorName === 'pi-agent' || candidate.executorName === 'hermes-agent')
        .length;
      if (researchCandidateCount >= 2) {
        return 'race_executors';
      }
    }

    return 'single_executor';
  }

  private buildSingleExecutorAcceptance(
    input: ExecutionPlanningInput,
    routeDecision: ExecutorRouteDecision,
  ): AcceptanceCriterion[] {
    const criteria: AcceptanceCriterion[] = [{
      id: 'user_request_satisfied',
      description: `最终结果必须回应用户原始需求：${input.userPrompt}`,
      requiredEvidence: ['最终输出或产物说明'],
      severity: 'must',
      appliesToWorkUnitIds: [],
    }];

    if (routeDecision.primaryIntent === 'repo_execution') {
      criteria.push({
        id: 'repo_execution_verified',
        description: '仓库修改任务必须提供测试结果，或说明未运行测试原因',
        requiredEvidence: ['测试命令', '测试结果', '未运行测试原因'],
        severity: 'must',
        appliesToWorkUnitIds: [],
      });
    }

    if (routeDecision.primaryIntent === 'research_workflow') {
      criteria.push({
        id: 'research_scope_clear',
        description: '调研任务必须说明来源、材料范围或来源限制',
        requiredEvidence: ['来源', '材料范围', '来源限制'],
        severity: 'should',
        appliesToWorkUnitIds: [],
      });
    }

    return criteria;
  }
}
