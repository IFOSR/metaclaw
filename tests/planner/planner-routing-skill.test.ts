import { describe, expect, it } from 'vitest';
import type { AgentClass, Task } from '../../src/core/types.js';
import type { CapabilityClass } from '../../src/core/capability-class.js';
import type { TaskRouteIntent } from '../../src/core/executor-router.js';
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

function agentClass(name: string, capabilities: string[], overrides: Partial<AgentClass> = {}): AgentClass {
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
    ...overrides,
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

  it('sorts candidates by route-intent affinity and excludes unavailable explicit executors', () => {
    const plan = new PlannerRoutingSkill().plan({
      task: task(),
      userPrompt: 'Please implement a TypeScript fix',
      taskExecutionPlan: {
        mode: 'create-new',
        title: 'Implement fix',
        goal: 'Please implement a TypeScript fix',
        resources: [],
        dependencies: [],
      },
      intentDecision: {
        interactionType: 'durable_task',
        confidence: 0.9,
        reason: 'repo work',
        clarificationQuestion: null,
        risk: { level: 'medium', requiresConfirmation: false, reasons: [] },
        task: { binding: 'new', taskId: null, control: 'none', scope: null },
        execution: {
          mode: 'single_executor',
          complexity: 'simple',
          selectedExecutor: 'unavailable-codex',
          candidateExecutors: ['unavailable-codex', 'repo-specialist', 'generic-high-success'],
          requiresVerification: true,
          canModifyFiles: true,
          requiresExternalGateway: false,
          capabilityClass: 'code_edit',
          primaryIntent: 'repo_execution',
          matchedBoundary: ['repo_execution'],
        },
        hints: [],
      },
      agentClasses: [
        agentClass('generic-high-success', ['coding'], {
          historicalSuccess: 0.95,
          intentAffinity: { repo_execution: 0.1 },
        }),
        agentClass('repo-specialist', ['coding'], {
          historicalSuccess: 0.2,
          intentAffinity: { repo_execution: 1 },
        }),
        agentClass('unavailable-codex', ['coding'], {
          availability: 'unavailable',
          historicalSuccess: 1,
          intentAffinity: { repo_execution: 1 },
        }),
      ],
      resources: [],
    });

    expect(plan.subtasks[0]?.candidateAgentClasses[0]).toBe('repo-specialist');
    expect(plan.subtasks[0]?.candidateAgentClasses).not.toContain('unavailable-codex');
    expect(plan.subtasks[0]?.agentClassHint).toBe('repo-specialist');
  });

  // The affinity ranking must key intentAffinity by the route-intent the seeded
  // agent classes actually use (repo_execution / research_workflow /
  // memory_agent_ops / general), reached via routeIntentFromCapability. Before
  // the fix it indexed by capabilityClass (code_edit/research/...) and the
  // lookup was always undefined, silently degrading to historicalSuccess.
  // Parameterized across every capability class so a fix that only works for
  // code_edit fails.
  const capabilityToRouteIntent: Array<{
    capabilityClass: CapabilityClass;
    routeIntent: TaskRouteIntent;
  }> = [
    { capabilityClass: 'code_edit', routeIntent: 'repo_execution' },
    { capabilityClass: 'research', routeIntent: 'research_workflow' },
    { capabilityClass: 'messaging', routeIntent: 'memory_agent_ops' },
    { capabilityClass: 'memory_ops', routeIntent: 'memory_agent_ops' },
    { capabilityClass: 'office_automation', routeIntent: 'memory_agent_ops' },
    { capabilityClass: 'general', routeIntent: 'general' },
    { capabilityClass: 'conversation', routeIntent: 'general' },
  ];

  it.each(capabilityToRouteIntent)(
    'ranks the executor with higher $routeIntent affinity above one with higher historicalSuccess for $capabilityClass',
    ({ capabilityClass, routeIntent }) => {
      const plan = new PlannerRoutingSkill().plan({
        task: task(),
        userPrompt: 'execute work',
        taskExecutionPlan: {
          mode: 'create-new',
          title: 'ranked',
          goal: 'execute work',
          resources: [],
          dependencies: [],
        },
        intentDecision: {
          interactionType: 'durable_task',
          confidence: 0.9,
          reason: 'work',
          clarificationQuestion: null,
          risk: { level: 'low', requiresConfirmation: false, reasons: [] },
          task: { binding: 'new', taskId: null, control: 'none', scope: null },
          execution: {
            mode: 'single_executor',
            complexity: 'simple',
            selectedExecutor: null,
            candidateExecutors: ['affinity-strong', 'success-strong'],
            requiresVerification: false,
            canModifyFiles: false,
            requiresExternalGateway: false,
            capabilityClass,
            primaryIntent: routeIntent,
            matchedBoundary: [routeIntent],
          },
          hints: [],
        },
        agentClasses: [
          agentClass('success-strong', ['coding', 'research', 'message', 'memory', 'office', 'conversation'], {
            historicalSuccess: 0.99,
            intentAffinity: { [routeIntent]: 0.1 } as Record<TaskRouteIntent, number>,
          }),
          agentClass('affinity-strong', ['coding', 'research', 'message', 'memory', 'office', 'conversation'], {
            historicalSuccess: 0.1,
            intentAffinity: { [routeIntent]: 1 } as Record<TaskRouteIntent, number>,
          }),
        ],
        resources: [],
      });

      // affinity-strong has lower historicalSuccess but higher route-intent affinity;
      // if the mapping works it must sort first, otherwise historicalSuccess wins.
      expect(plan.subtasks[0]?.candidateAgentClasses[0]).toBe('affinity-strong');
    },
  );

  it('leaves candidate agent classes empty when no executor class is available', () => {
    const plan = new PlannerRoutingSkill().plan({
      task: task(),
      userPrompt: 'Please implement a TypeScript fix',
      taskExecutionPlan: {
        mode: 'create-new',
        title: 'Implement fix',
        goal: 'Please implement a TypeScript fix',
        resources: [],
        dependencies: [],
      },
      intentDecision: {
        interactionType: 'durable_task',
        confidence: 0.9,
        reason: 'repo work',
        clarificationQuestion: null,
        risk: { level: 'medium', requiresConfirmation: false, reasons: [] },
        task: { binding: 'new', taskId: null, control: 'none', scope: null },
        execution: {
          mode: 'single_executor',
          complexity: 'simple',
          selectedExecutor: 'unavailable-codex',
          candidateExecutors: ['unavailable-codex'],
          requiresVerification: true,
          canModifyFiles: true,
          requiresExternalGateway: false,
          capabilityClass: 'code_edit',
          primaryIntent: 'repo_execution',
          matchedBoundary: ['repo_execution'],
        },
        hints: [],
      },
      agentClasses: [
        agentClass('unavailable-codex', ['coding'], { availability: 'unavailable' }),
      ],
      resources: [],
    });

    expect(plan.subtasks[0]?.candidateAgentClasses).toEqual([]);
    expect(plan.subtasks[0]?.agentClassHint).toBeNull();
  });
});

describe('PlannerRoutingSkill subtask id stability', () => {
  function singlePlan(userPrompt: string): { ids: string[] } {
    const plan = new PlannerRoutingSkill().plan({
      task: task(),
      userPrompt,
      taskExecutionPlan: {
        mode: 'create-new',
        title: 'Implement fix',
        goal: userPrompt,
        resources: [],
        dependencies: [],
      },
      intentDecision: {
        interactionType: 'durable_task',
        confidence: 0.9,
        reason: 'repo work',
        clarificationQuestion: null,
        risk: { level: 'medium', requiresConfirmation: false, reasons: [] },
        task: { binding: 'new', taskId: null, control: 'none', scope: null },
        execution: {
          mode: 'single_executor',
          complexity: 'simple',
          selectedExecutor: 'codex-cli',
          candidateExecutors: ['codex-cli'],
          requiresVerification: true,
          canModifyFiles: true,
          requiresExternalGateway: false,
          capabilityClass: 'code_edit',
          primaryIntent: 'repo_execution',
          matchedBoundary: ['repo_execution'],
        },
        hints: [],
      },
      agentClasses: [agentClass('codex-cli', ['coding'])],
      resources: [],
    });
    return { ids: plan.subtasks.map(subtask => subtask.id) };
  }

  // Prompts that trigger multi_executor vary by complexity signals; each case is one real
  // multi-domain prompt the strategy planner must split into >1 subtask.
  const multiExecutorPrompts = [
    '请先 research 背景资料，然后 implement 代码，最后 review 风险',
    '先调研竞品，再实现补丁，最后审查验收',
    '分别做研究和实现，多视角 review',
  ];

  function multiPlan(userPrompt: string): { ids: string[]; subtaskCount: number } {
    const plan = new PlannerRoutingSkill().plan({
      task: task(),
      userPrompt,
      taskExecutionPlan: {
        mode: 'create-new',
        title: 'Multi-step work',
        goal: userPrompt,
        resources: [],
        dependencies: [],
      },
      intentDecision: null,
      agentClasses: [
        agentClass('codex-cli', ['coding']),
        agentClass('hermes-agent', ['research']),
      ],
      resources: ['README.md', 'NOTES.md'],
    });
    return {
      ids: plan.subtasks.map(subtask => subtask.id),
      subtaskCount: plan.subtasks.length,
    };
  }

  it.each(multiExecutorPrompts)('produces >1 subtask for multi_executor prompt %j', (prompt) => {
    const { subtaskCount } = multiPlan(prompt);
    expect(subtaskCount).toBeGreaterThan(1);
  });

  it.each(multiExecutorPrompts)('keeps subtask ids unique within a multi_executor plan for %j', (prompt) => {
    const { ids } = multiPlan(prompt);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('single_executor and multi_executor subtask ids never collide across replans of the same task', () => {
    const singleIds = new Set(singlePlan('implement a fix').ids);
    const allMultiIds = multiExecutorPrompts.flatMap(prompt => multiPlan(prompt).ids);
    const collision = allMultiIds.filter(id => singleIds.has(id));
    expect(collision).toEqual([]);
  });

  it('prefixes every subtask id with the owning task id so cross-task plans stay disjoint', () => {
    const single = singlePlan('implement a fix');
    const multi = multiPlan(multiExecutorPrompts[0]!);
    for (const id of [...single.ids, ...multi.ids]) {
      expect(id.startsWith('task_plan_')).toBe(true);
    }
  });
});
