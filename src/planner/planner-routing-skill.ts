import type { ExecutionPlan } from '../session/session-helpers.js';
import type { AgentClass, AgentClassKind, AgentClassRiskLevel, Subtask, Task } from '../core/types.js';
import type { IntentDecisionV2 } from '../core/intent-orchestrator.js';
import type { CapabilityClass } from '../core/capability-class.js';
import type { TaskRouteIntent } from '../core/executor-router.js';
import { ExecutionStrategyPlanner } from '../core/execution-strategy-planner.js';

export interface SubtaskPlan {
  id: string;
  title: string;
  goal: string;
  dependsOn: string[];
  requiredAgentClassKind: AgentClassKind;
  agentClassHint: string | null;
  candidateAgentClasses: string[];
  expectedOutput: Subtask['expectedOutput'];
  acceptance: string[];
  riskLevel: AgentClassRiskLevel;
}

export interface WorkGraphPlan {
  taskId: string;
  reason: string;
  subtasks: SubtaskPlan[];
}

export interface PlannerRoutingSkillInput {
  task: Task;
  userPrompt: string;
  taskExecutionPlan: ExecutionPlan;
  intentDecision?: IntentDecisionV2 | null;
  agentClasses: AgentClass[];
  resources: string[];
  recalledTaskIds?: string[];
}

function searchableAgentClassText(agentClass: AgentClass): string {
  return [
    agentClass.name,
    ...agentClass.domains,
    ...agentClass.capabilities,
    ...agentClass.inputTypes,
    ...agentClass.outputTypes,
    ...agentClass.strengths,
    ...agentClass.primaryUseCases,
  ].join('\n').toLowerCase();
}

function matchesCapability(agentClass: AgentClass, capabilityClass: CapabilityClass): boolean {
  const text = searchableAgentClassText(agentClass);
  if (capabilityClass === 'code_edit') return /code|coding|repo|software|typescript|patch|test|codex|claude/.test(text);
  if (capabilityClass === 'research') return /research|report|analysis|pi-agent|hermes/.test(text);
  if (capabilityClass === 'messaging') return /message|gateway|notification|feishu|openclaw|hermes/.test(text);
  if (capabilityClass === 'memory_ops') return /memory|mcp|skill|automation|hermes|pi-agent/.test(text);
  if (capabilityClass === 'office_automation') return /office|document|spreadsheet|slides|automation|openclaw|hermes/.test(text);
  if (capabilityClass === 'conversation') return /conversation|control|general/.test(text);
  return true;
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function routeIntentFromCapability(capabilityClass: CapabilityClass): TaskRouteIntent {
  if (capabilityClass === 'code_edit') return 'repo_execution';
  if (capabilityClass === 'research') return 'research_workflow';
  if (capabilityClass === 'messaging' || capabilityClass === 'memory_ops' || capabilityClass === 'office_automation') {
    return 'memory_agent_ops';
  }
  return 'general';
}

function chooseCandidates(input: PlannerRoutingSkillInput, capabilityClass: CapabilityClass): string[] {
  const availableExecutors = input.agentClasses
    .filter(agentClass => agentClass.kind === 'executor')
    .filter(agentClass => agentClass.availability === 'available');
  const routeIntent = routeIntentFromCapability(capabilityClass);
  const matched = availableExecutors
    .filter(agentClass => matchesCapability(agentClass, capabilityClass))
    .sort((left, right) => {
      const leftAffinity = left.intentAffinity[routeIntent] ?? left.historicalSuccess;
      const rightAffinity = right.intentAffinity[routeIntent] ?? right.historicalSuccess;
      return rightAffinity - leftAffinity;
    })
    .map(agentClass => agentClass.name);
  const explicit = availableExecutors.find(agentClass =>
    agentClass.name === input.intentDecision?.execution.selectedExecutor
  )?.name ?? null;
  return unique([
    explicit ?? '',
    ...matched,
    ...availableExecutors.map(agentClass => agentClass.name),
  ]);
}

function riskFromCapability(capabilityClass: CapabilityClass): AgentClassRiskLevel {
  return capabilityClass === 'code_edit' ? 'medium' : 'low';
}

function candidateList(hint: string | null, candidates: string[]): string[] {
  return unique([
    hint && candidates.includes(hint) ? hint : '',
    ...candidates,
  ]);
}

function agentClassHint(hint: string | null, candidates: string[]): string | null {
  return hint && candidates.includes(hint) ? hint : null;
}

function stableSubtaskId(taskId: string, unitId: string, used: Set<string>): string {
  const base = `${taskId}_${unitId}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  for (;;) {
    const candidate = `${base}_${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    index += 1;
  }
}

export class PlannerRoutingSkill {
  constructor(private readonly strategyPlanner = new ExecutionStrategyPlanner()) {}

  plan(input: PlannerRoutingSkillInput): WorkGraphPlan {
    const capabilityClass = input.intentDecision?.execution.capabilityClass ?? 'general';
    const candidates = chooseCandidates(input, capabilityClass);
    const primaryExecutor = candidates[0] ?? '';
    const strategy = this.strategyPlanner.plan({
      task: input.task,
      userPrompt: input.userPrompt,
      executionPlan: input.taskExecutionPlan,
      primaryExecutor,
      candidateExecutors: candidates,
      capabilityClass,
      matchedBoundary: input.intentDecision?.execution.matchedBoundary?.length
        ? input.intentDecision.execution.matchedBoundary
        : [capabilityClass],
      riskLevel: input.intentDecision?.risk.level ?? riskFromCapability(capabilityClass),
      retrievedTasks: (input.recalledTaskIds ?? []).map(taskId => ({
        taskId,
        score: 1,
        recallMode: 'related' as const,
        sources: [],
        artifacts: [],
        pitfalls: [],
        reason: 'approved recall selection',
      })),
      resources: input.resources,
    });

    if (strategy.mode === 'single_executor') {
      const expectedOutput = capabilityClass === 'code_edit' ? 'patch' : 'summary';
      return {
        taskId: input.task.id,
        reason: strategy.reason,
        subtasks: [{
          id: `${input.task.id}_subtask_execute`,
          title: input.task.title || 'Execute task',
          goal: input.userPrompt,
          dependsOn: [],
          requiredAgentClassKind: 'executor',
          agentClassHint: agentClassHint(strategy.executorName, candidates),
          candidateAgentClasses: candidateList(strategy.executorName, candidates),
          expectedOutput,
          acceptance: expectedOutput === 'patch'
            ? ['List changed files and provide test command output or explain why tests were not run.']
            : ['Satisfy the user request and report verification or remaining risk.'],
          riskLevel: input.intentDecision?.risk.level ?? riskFromCapability(capabilityClass),
        }],
      };
    }

    const usedIds = new Set<string>();
    return {
      taskId: input.task.id,
      reason: strategy.reason,
      subtasks: strategy.subtasks.map(unit => {
        const id = stableSubtaskId(input.task.id, unit.id, usedIds);
        return {
          id,
          title: unit.title,
          goal: unit.goal,
          dependsOn: unit.dependsOn.map(dependencyId => `${input.task.id}_${dependencyId}`),
          requiredAgentClassKind: 'executor',
          agentClassHint: agentClassHint(unit.executorHint, candidates),
          candidateAgentClasses: candidateList(unit.executorHint, candidates),
          expectedOutput: unit.expectedOutput,
          acceptance: unit.acceptance,
          riskLevel: unit.riskLevel,
        };
      }),
    };
  }
}
