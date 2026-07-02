import { describe, expect, it } from 'vitest';
import { ExecutionPlanningService } from '../../src/core/execution-planning-service.js';
import { buildFallbackIntentDecision, type ExecutorProfile } from '../../src/core/executor-router.js';
import type { IntentDecisionV2 } from '../../src/core/intent-orchestrator.js';
import type { Task } from '../../src/core/types.js';
import type { ExecutionPlan } from '../../src/session/session-helpers.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_plan',
    title: '计划任务',
    goal: '完成计划任务',
    status: 'running',
    summary: '',
    snapshots: [],
    resources: [],
    artifacts: [],
    dependencies: [],
    prioritySignals: {
      dueAt: null,
      isReady: true,
      progressRatio: 0,
      blocksOthers: false,
      idleHours: 0,
    },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: '2026-06-22T00:00:00Z',
    updatedAt: '2026-06-22T00:00:00Z',
    ...overrides,
  };
}

function executionPlan(): ExecutionPlan {
  return {
    mode: 'reuse-existing',
    executionTaskId: 'task_plan',
    contextTaskId: 'task_plan',
    transitions: [],
  };
}

function profile(name: string, capabilities: string[] = ['general']): ExecutorProfile {
  return {
    name,
    domains: capabilities,
    capabilities,
    inputTypes: ['text'],
    outputTypes: ['markdown'],
    strengths: [],
    weaknesses: [],
    riskLevel: 'low',
    availability: 'available',
    historicalSuccess: 0.8,
  };
}

describe('ExecutionPlanningService', () => {
  it('creates a single-executor plan with acceptance criteria', () => {
    const plan = new ExecutionPlanningService().plan({
      task: task(),
      userPrompt: '实现一个 TypeScript 修复并说明测试',
      taskExecutionPlan: executionPlan(),
      semanticDecision: buildFallbackIntentDecision({
        target: 'codex-cli',
        primaryIntent: 'repo_execution',
        routeIntent: 'repo_execution',
        matchedBoundary: ['repo_mutation'],
        requiredCapabilities: ['coding'],
        reason: 'repo work',
      }),
      executorProfiles: [profile('codex-cli', ['coding'])],
      defaultExecutorName: 'codex-cli',
      resources: [],
    });

    expect(plan.mode).toBe('single_executor');
    expect(plan.primaryExecutor).toBe('codex-cli');
    expect(plan.acceptanceCriteria.map(criterion => criterion.id)).toContain('repo_execution_verified');
  });

  it('plans directly from IntentDecisionV2 execution without requiring legacy IntentDecision adaptation', () => {
    const intentDecision: IntentDecisionV2 = {
      interactionType: 'executor_dispatch',
      confidence: 0.88,
      reason: 'repo execution from v2 decision',
      clarificationQuestion: null,
      risk: {
        level: 'medium',
        requiresConfirmation: false,
        reasons: ['repo execution from v2 decision'],
      },
      task: {
        binding: 'new',
        taskId: null,
        control: 'none',
        scope: null,
      },
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
        matchedBoundary: ['repo_mutation'],
      },
      hints: [],
    };

    const plan = new ExecutionPlanningService().plan({
      task: task(),
      userPrompt: '实现一个 TypeScript 修复并说明测试',
      taskExecutionPlan: executionPlan(),
      intentDecision,
      executorProfiles: [profile('codex-cli', ['coding'])],
      defaultExecutorName: 'codex-cli',
      resources: [],
    });

    expect(plan.mode).toBe('single_executor');
    expect(plan.primaryExecutor).toBe('codex-cli');
    expect(plan.capabilityClasses).toEqual(['code_edit']);
    expect(plan.acceptanceCriteria.map(criterion => criterion.id)).toContain('repo_execution_verified');
  });

  it('keeps research workflows on a single executor even with multiple research candidates', () => {
    const plan = new ExecutionPlanningService().plan({
      task: task(),
      userPrompt: '调研 pi agent 和 hermes agent 并输出报告',
      taskExecutionPlan: executionPlan(),
      semanticDecision: buildFallbackIntentDecision({
        target: 'pi-agent',
        primaryIntent: 'research_workflow',
        routeIntent: 'research_workflow',
        matchedBoundary: ['research'],
        requiredCapabilities: ['research'],
        reason: 'research work',
      }),
      executorProfiles: [
        profile('codex-cli'),
        profile('pi-agent', ['research']),
        profile('hermes-agent', ['research']),
      ],
      defaultExecutorName: 'codex-cli',
      resources: [],
    });

    expect(plan.mode).toBe('single_executor');
    expect(plan.candidateExecutors).toContain('pi-agent');
    expect(plan.candidateExecutors).toContain('hermes-agent');
  });

  it('creates a multi-executor plan for explicit multi-agent complex tasks', () => {
    const plan = new ExecutionPlanningService().plan({
      task: task(),
      userPrompt: '请多个 agent 分别调研、实现、review 这个方案，最后汇总',
      taskExecutionPlan: executionPlan(),
      semanticDecision: buildFallbackIntentDecision({
        target: 'codex-cli',
        primaryIntent: 'repo_execution',
        routeIntent: 'repo_execution',
        matchedBoundary: ['repo_mutation', 'research', 'review'],
        requiredCapabilities: ['coding', 'research', 'review'],
        reason: 'complex work',
      }),
      executorProfiles: [
        profile('codex-cli', ['coding']),
        profile('hermes-agent', ['research']),
        profile('deepseek-tui', ['review']),
      ],
      defaultExecutorName: 'codex-cli',
      resources: ['docs/spec.md', 'docs/review.md'],
    });

    expect(plan.mode).toBe('multi_executor');
    expect(plan.subtasks.length).toBeGreaterThan(1);
    expect(plan.acceptanceCriteria.map(criterion => criterion.id)).toContain('user_request_satisfied');
  });

  it('keeps ordinary email drafting about project risks on a single executor', () => {
    const plan = new ExecutionPlanningService().plan({
      task: task(),
      userPrompt: '再给张总写一封邮件，内容是同步项目风险，用正式语气',
      taskExecutionPlan: executionPlan(),
      semanticDecision: buildFallbackIntentDecision({
        target: 'codex-cli',
        primaryIntent: 'general',
        routeIntent: 'general',
        matchedBoundary: ['general'],
        reason: 'ordinary email drafting',
      }),
      executorProfiles: [profile('codex-cli')],
      defaultExecutorName: 'codex-cli',
      resources: [],
    });

    expect(plan.mode).toBe('single_executor');
    expect(plan.subtasks).toEqual([]);
    expect(plan.acceptanceCriteria.map(criterion => criterion.id)).toEqual(['user_request_satisfied']);
  });
});
