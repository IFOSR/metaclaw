import type { ExecutionPlan } from '../session/session-helpers.js';
import type { AgentClass, AgentClassKind, AgentClassRiskLevel, Subtask, Task } from '../core/types.js';
import type { IntentDecisionV2 } from '../core/intent-orchestrator.js';
import type { CapabilityClass } from '../core/capability-class.js';
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

function chooseCandidates(input: PlannerRoutingSkillInput, capabilityClass: CapabilityClass): string[] {
  const availableExecutors = input.agentClasses
    .filter(agentClass => agentClass.kind === 'executor')
    .filter(agentClass => agentClass.availability === 'available');
  const matched = availableExecutors
    .filter(agentClass => matchesCapability(agentClass, capabilityClass))
    .sort((left, right) => {
      const leftAffinity = left.intentAffinity[capabilityClass] ?? left.historicalSuccess;
      const rightAffinity = right.intentAffinity[capabilityClass] ?? right.historicalSuccess;
      return rightAffinity - leftAffinity;
    })
    .map(agentClass => agentClass.name);
  const explicit = input.intentDecision?.execution.selectedExecutor ?? null;
  return unique([
    explicit ?? '',
    ...matched,
    ...availableExecutors.map(agentClass => agentClass.name),
  ]);
}

function riskFromCapability(capabilityClass: CapabilityClass): AgentClassRiskLevel {
  return capabilityClass === 'code_edit' ? 'medium' : 'low';
}

export class PlannerRoutingSkill {
  constructor(private readonly strategyPlanner = new ExecutionStrategyPlanner()) {}

  plan(input: PlannerRoutingSkillInput): WorkGraphPlan {
    const capabilityClass = input.intentDecision?.execution.capabilityClass ?? 'general';
    const candidates = chooseCandidates(input, capabilityClass);
    const primaryExecutor = candidates[0] ?? input.agentClasses.find(agentClass => agentClass.kind === 'executor')?.name ?? 'executor';
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
          id: `${input.task.id}_subtask_summary`,
          title: input.task.title || 'Execute task',
          goal: input.userPrompt,
          dependsOn: [],
          requiredAgentClassKind: 'executor',
          agentClassHint: strategy.executorName,
          candidateAgentClasses: unique([strategy.executorName, ...candidates]),
          expectedOutput,
          acceptance: expectedOutput === 'patch'
            ? ['List changed files and provide test command output or explain why tests were not run.']
            : ['Satisfy the user request and report verification or remaining risk.'],
          riskLevel: input.intentDecision?.risk.level ?? riskFromCapability(capabilityClass),
        }],
      };
    }

    return {
      taskId: input.task.id,
      reason: strategy.reason,
      subtasks: strategy.subtasks.map(unit => ({
        id: `${input.task.id}_${unit.id}`,
        title: unit.title,
        goal: unit.goal,
        dependsOn: unit.dependsOn.map(id => `${input.task.id}_${id}`),
        requiredAgentClassKind: 'executor',
        agentClassHint: unit.executorHint,
        candidateAgentClasses: unique([unit.executorHint, ...candidates]),
        expectedOutput: unit.expectedOutput,
        acceptance: unit.acceptance,
        riskLevel: unit.riskLevel,
      })),
    };
  }
}
