// Routing policy module that selects executors and builds the ExecutionPolicy runtime consumes.
import type { ExecutionPlan } from '../session/session-helpers.js';
import type { CapabilityClass } from '../core/capability-class.js';
import type { ExecutionPolicy, EstimatedCostClass, ExecutionRiskLevel, VerificationLevel } from '../core/execution-policy.js';
import type {
  ExecutorProfile,
  ExecutorRouteCandidate,
  ExecutorRouteDecision,
  ExecutorRouteRejectedCandidate,
  IntentDecision,
  TaskRouteIntent,
} from '../core/executor-router.js';
import {
  capabilityClassFromTaskRouteIntent,
  taskRouteIntentFromCapabilityClass,
} from '../core/executor-router.js';
import type { IntentDecisionV2 } from '../core/intent-orchestrator.js';
import { ExecutionStrategyPlanner, type AcceptanceCriterion } from '../core/execution-strategy-planner.js';
import type { Task } from '../core/types.js';

export interface ExecutionPolicyPlanningInput {
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

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function searchableProfileText(profile: ExecutorProfile): string {
  return [
    profile.name,
    ...profile.domains,
    ...profile.capabilities,
    ...profile.inputTypes,
    ...profile.outputTypes,
    ...profile.strengths,
    ...(profile.primaryUseCases ?? []),
  ].join('\n').toLowerCase();
}

function profileMatchesCapability(profile: ExecutorProfile, capabilityClass: CapabilityClass): boolean {
  const text = searchableProfileText(profile);
  if (capabilityClass === 'code_edit') {
    return /code|coding|repo|software|typescript|patch|test|deepseek|codex|claude/.test(text);
  }
  if (capabilityClass === 'research') {
    return /research|report|analysis|pi-agent|hermes/.test(text);
  }
  if (capabilityClass === 'messaging') {
    return /message|gateway|notification|feishu|openclaw|hermes/.test(text);
  }
  if (capabilityClass === 'memory_ops') {
    return /memory|mcp|skill|automation|hermes|pi-agent/.test(text);
  }
  if (capabilityClass === 'office_automation') {
    return /office|document|spreadsheet|slides|automation|openclaw|hermes/.test(text);
  }
  if (capabilityClass === 'conversation') {
    return /conversation|control|general/.test(text);
  }
  return true;
}

function profileRiskToPolicyRisk(value: ExecutorProfile['riskLevel']): ExecutionRiskLevel {
  if (value === 'high') return 'high';
  if (value === 'medium') return 'medium';
  return 'low';
}

function buildCandidates(input: ExecutionPolicyPlanningInput, capabilityClass: CapabilityClass): string[] {
  const availableProfiles = input.executorProfiles.filter(profile => profile.availability === 'available');
  const explicitCandidates = [
    input.intentDecision?.execution.selectedExecutor ?? null,
    ...(input.intentDecision?.execution.candidateExecutors ?? []),
    input.semanticDecision?.route.target ?? null,
  ].filter((item): item is string => Boolean(item));
  const capabilityMatches = availableProfiles
    .filter(profile => profileMatchesCapability(profile, capabilityClass))
    .map(profile => profile.name);

  return unique([
    ...explicitCandidates,
    ...capabilityMatches,
    input.defaultExecutorName,
  ]);
}

function selectPrimary(input: ExecutionPolicyPlanningInput, candidates: string[]): string {
  const explicit = input.intentDecision?.execution.selectedExecutor
    ?? input.semanticDecision?.route.target
    ?? null;
  if (explicit && candidates.includes(explicit)) {
    return explicit;
  }
  if (candidates.includes(input.defaultExecutorName)) {
    return input.defaultExecutorName;
  }
  return candidates[0] ?? input.defaultExecutorName;
}

function getCapabilityClass(input: ExecutionPolicyPlanningInput): CapabilityClass {
  return input.intentDecision?.execution.capabilityClass
    ?? capabilityClassFromTaskRouteIntent(input.semanticDecision?.route.routeIntent)
    ?? 'general';
}

function getRiskLevel(input: ExecutionPolicyPlanningInput, primaryProfile: ExecutorProfile | null): ExecutionRiskLevel {
  if (input.intentDecision?.risk.level) {
    return input.intentDecision.risk.level;
  }
  if (input.semanticDecision?.route.riskLevel) {
    return input.semanticDecision.route.riskLevel;
  }
  return primaryProfile ? profileRiskToPolicyRisk(primaryProfile.riskLevel) : 'low';
}

function getEstimatedCostClass(input: ExecutionPolicyPlanningInput, capabilityClass: CapabilityClass): EstimatedCostClass {
  if (input.resources.length >= 3 || input.userPrompt.length > 1200) {
    return 'expensive';
  }
  if (capabilityClass === 'code_edit' || capabilityClass === 'research') {
    return 'moderate';
  }
  return 'cheap';
}

function getVerificationLevel(input: ExecutionPolicyPlanningInput, capabilityClass: CapabilityClass): VerificationLevel {
  if (input.intentDecision?.execution.requiresVerification || capabilityClass === 'code_edit') {
    return 'test';
  }
  return 'none';
}

function buildFallbackChain(input: ExecutionPolicyPlanningInput, primaryExecutor: string): string[] {
  const explicitFallbacks = unique(input.intentDecision?.execution.candidateExecutors ?? [])
    .filter(executorName => executorName !== primaryExecutor);
  if (primaryExecutor === input.defaultExecutorName) {
    return [];
  }
  return unique([input.defaultExecutorName, ...explicitFallbacks])
    .filter(executorName => executorName !== primaryExecutor);
}

function buildRouteDecision(input: {
  primaryExecutor: string;
  candidates: string[];
  primaryIntent: TaskRouteIntent;
  matchedBoundary: string[];
  reason: string;
  confidence: number;
  riskLevel: ExecutionRiskLevel;
}): ExecutorRouteDecision {
  const candidateRecords: ExecutorRouteCandidate[] = input.candidates.map((executorName, index) => ({
    executorName,
    score: Math.max(0.1, 1 - index * 0.1),
    reason: executorName === input.primaryExecutor ? 'primary executor from ExecutionPolicy' : 'fallback candidate from ExecutionPolicy',
    primaryIntent: input.primaryIntent,
    matchedBoundary: input.matchedBoundary,
  }));
  const rejected: ExecutorRouteRejectedCandidate[] = candidateRecords
    .filter(candidate => candidate.executorName !== input.primaryExecutor)
    .map(candidate => ({
      executorName: candidate.executorName,
      score: candidate.score,
      reason: 'not selected as primary by ExecutionPolicy',
    }));

  return {
    selectedExecutor: input.primaryExecutor,
    action: input.riskLevel === 'high' ? 'ask_review' : 'auto_dispatch',
    confidence: input.confidence,
    candidates: candidateRecords,
    reason: input.reason,
    primaryIntent: input.primaryIntent,
    matchedBoundary: input.matchedBoundary,
    rejected,
  };
}

export function buildRouteDecisionFromPolicy(policy: ExecutionPolicy): ExecutorRouteDecision {
  const primaryIntent = taskRouteIntentFromCapabilityClass(policy.capabilityClasses[0] ?? 'general');
  return buildRouteDecision({
    primaryExecutor: policy.primaryExecutor,
    candidates: policy.candidateExecutors,
    primaryIntent,
    matchedBoundary: policy.capabilityClasses,
    reason: policy.reason,
    confidence: 0.85,
    riskLevel: policy.riskLevel,
  });
}

export class ExecutionPolicyPlanner {
  constructor(private readonly strategyPlanner = new ExecutionStrategyPlanner()) {}

  plan(input: ExecutionPolicyPlanningInput): ExecutionPolicy {
    const capabilityClass = getCapabilityClass(input);
    const candidates = buildCandidates(input, capabilityClass);
    const primaryExecutor = selectPrimary(input, candidates);
    const primaryProfile = input.executorProfiles.find(profile => profile.name === primaryExecutor) ?? null;
    const riskLevel = getRiskLevel(input, primaryProfile);
    const matchedBoundary = input.intentDecision?.execution.matchedBoundary?.length
      ? input.intentDecision.execution.matchedBoundary
      : input.semanticDecision?.route.matchedBoundary?.length
        ? input.semanticDecision.route.matchedBoundary
        : [capabilityClass];
    const strategy = this.strategyPlanner.plan({
      task: input.task,
      userPrompt: input.userPrompt,
      executionPlan: input.taskExecutionPlan,
      primaryExecutor,
      candidateExecutors: candidates,
      capabilityClass,
      matchedBoundary,
      riskLevel,
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
    const acceptanceCriteria = strategy.mode === 'multi_executor'
      ? strategy.aggregation.criteria
      : this.buildSingleExecutorAcceptance(input, capabilityClass);

    return {
      taskId: input.task.id,
      mode: strategy.mode,
      primaryExecutor,
      candidateExecutors: candidates,
      isolationRequired: strategy.mode === 'multi_executor' || capabilityClass === 'code_edit',
      verificationLevel: getVerificationLevel(input, capabilityClass),
      reviewerExecutor: null,
      riskLevel,
      estimatedCostClass: getEstimatedCostClass(input, capabilityClass),
      fallbackChain: buildFallbackChain(input, primaryExecutor),
      acceptanceCriteria,
      capabilityClasses: [capabilityClass],
      reason: strategy.reason,
      strategy,
      workUnits: strategy.mode === 'multi_executor' ? strategy.workUnits : [],
    };
  }

  private buildSingleExecutorAcceptance(
    input: ExecutionPolicyPlanningInput,
    capabilityClass: CapabilityClass,
  ): AcceptanceCriterion[] {
    const criteria: AcceptanceCriterion[] = [{
      id: 'user_request_satisfied',
      description: `Final result must satisfy the original user request: ${input.userPrompt}`,
      requiredEvidence: ['final output or artifact explanation'],
      severity: 'must',
      appliesToWorkUnitIds: [],
    }];

    if (capabilityClass === 'code_edit') {
      criteria.push({
        id: 'repo_execution_verified',
        description: 'Repository modification tasks must provide test results or explain why tests were not run.',
        requiredEvidence: ['test command', 'test result', 'reason tests were not run'],
        severity: 'must',
        appliesToWorkUnitIds: [],
      });
    }

    if (capabilityClass === 'research') {
      criteria.push({
        id: 'research_scope_clear',
        description: 'Research tasks must state sources, material scope, or source limitations.',
        requiredEvidence: ['sources', 'material scope', 'source limitations'],
        severity: 'should',
        appliesToWorkUnitIds: [],
      });
    }

    return criteria;
  }
}
