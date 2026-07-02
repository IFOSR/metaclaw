import { describe, expect, it } from 'vitest';
import type { AgentClass, Task } from '../../src/core/types.js';
import { PlannerRoutingSkill } from '../../src/planner/planner-routing-skill.js';

function task(): Task {
  return {
    id: 'task_plan',
    title: 'Implement and review',
    goal: 'Research context then implement code and review',
    status: 'running',
    summary: '',
    snapshots: [],
    resources: ['README.md'],
    artifacts: [],
    dependencies: [],
    prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  };
}

function agentClass(name: string, capabilities: string[]): AgentClass {
  return {
    name,
    kind: 'executor',
    domains: ['software'],
    capabilities,
    inputTypes: ['text'],
    outputTypes: ['markdown'],
    strengths: capabilities,
    weaknesses: [],
    primaryUseCases: [],
    avoidUseCases: [],
    intentAffinity: {},
    riskLevel: 'medium',
    availability: 'available',
    historicalSuccess: 0.8,
    harness: 'cli',
    model: null,
    skills: [],
    mcpServers: [],
    plugins: [],
    runtimeCommand: null,
    runtimeArgs: [],
    runtimeCheckCommand: null,
    projectUrl: null,
  };
}

describe('PlannerRoutingSkill', () => {
  it('builds subtask plans with candidate agent classes and no execution policy', () => {
    const plan = new PlannerRoutingSkill().plan({
      task: task(),
      userPrompt: '请先 research，再 implement 代码，最后 review',
      taskExecutionPlan: {
        mode: 'create-new',
        title: 'Implement and review',
        goal: 'Research context then implement code and review',
        resources: [],
        dependencies: [],
      },
      agentClasses: [
        agentClass('codex-cli', ['coding', 'tests']),
        agentClass('hermes-agent', ['research']),
      ],
      resources: ['README.md'],
    });

    expect(plan.taskId).toBe('task_plan');
    expect(plan.subtasks.length).toBeGreaterThanOrEqual(1);
    expect(plan.subtasks[0]).toMatchObject({
      requiredAgentClassKind: 'executor',
    });
    expect(plan.subtasks.flatMap(subtask => subtask.candidateAgentClasses)).toContain('codex-cli');
    expect(JSON.stringify(plan)).not.toContain('primaryExecutor');
    expect(JSON.stringify(plan)).not.toContain('fallbackChain');
  });
});
