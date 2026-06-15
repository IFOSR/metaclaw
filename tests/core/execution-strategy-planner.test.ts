import { describe, expect, it } from 'vitest';
import { ExecutionStrategyPlanner } from '../../src/core/execution-strategy-planner.js';
import type { Task } from '../../src/core/types.js';
import type { ExecutionPlan } from '../../src/session/session-helpers.js';
import type { ExecutorRouteDecision } from '../../src/core/executor-router.js';
import type { RetrievedTaskCandidate } from '../../src/core/hybrid-task-retriever.js';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_strategy',
    title: '策略测试任务',
    goal: '验证 execution strategy planner',
    status: 'ready',
    summary: '',
    snapshots: [],
    resources: [],
    artifacts: [],
    dependencies: [],
    prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: '2026-06-14T10:00:00.000Z',
    updatedAt: '2026-06-14T10:00:00.000Z',
    ...overrides,
  };
}

function createExecutionPlan(): ExecutionPlan {
  return {
    mode: 'reuse-existing',
    executionTaskId: 'task_strategy',
    contextTaskId: 'task_strategy',
    transitions: ['ready'],
  };
}

function createRouteDecision(overrides: Partial<ExecutorRouteDecision> = {}): ExecutorRouteDecision {
  return {
    selectedExecutor: 'codex-cli',
    action: 'auto_dispatch',
    confidence: 0.8,
    candidates: [],
    reason: 'test route',
    primaryIntent: 'repo_execution',
    matchedBoundary: ['repo_mutation'],
    rejected: [],
    ...overrides,
  };
}

function createRetrievedTask(taskId: string): RetrievedTaskCandidate {
  return {
    taskId,
    score: 80,
    recallMode: 'reference',
    sources: [{ kind: 'fts', sourceId: taskId, snippet: 'related task' }],
    artifacts: [],
    pitfalls: [],
    reason: 'related',
  };
}

describe('ExecutionStrategyPlanner', () => {
  it('keeps a single repo bugfix on the selected executor', () => {
    const strategy = new ExecutionStrategyPlanner().plan({
      task: createTask(),
      userPrompt: '修复这个 TypeScript bug 并跑测试',
      executionPlan: createExecutionPlan(),
      routeDecision: createRouteDecision(),
      retrievedTasks: [],
      resources: [],
    });

    expect(strategy).toMatchObject({
      mode: 'single_executor',
      executorName: 'codex-cli',
    });
    expect(strategy.reason.length).toBeGreaterThan(0);
  });

  it('keeps a single technical explanation on one executor', () => {
    const strategy = new ExecutionStrategyPlanner().plan({
      task: createTask(),
      userPrompt: '解释一下 SQLite FTS5 的原理',
      executionPlan: createExecutionPlan(),
      routeDecision: createRouteDecision({
        selectedExecutor: 'deepseek-tui',
        primaryIntent: 'technical_reasoning',
        matchedBoundary: ['reasoning'],
      }),
      retrievedTasks: [],
      resources: [],
    });

    expect(strategy).toMatchObject({
      mode: 'single_executor',
      executorName: 'deepseek-tui',
    });
  });

  it('plans research, implementation, review, and aggregation for staged complex work', () => {
    const strategy = new ExecutionStrategyPlanner().plan({
      task: createTask(),
      userPrompt: '先调研竞品，再实现 README 修改，最后 review 验证',
      executionPlan: createExecutionPlan(),
      routeDecision: createRouteDecision({
        selectedExecutor: 'codex-cli',
        primaryIntent: 'repo_execution',
        matchedBoundary: ['repo_mutation', 'research', 'code_review'],
      }),
      retrievedTasks: [createRetrievedTask('task_old_research')],
      resources: ['docs/material.md'],
    });

    expect(strategy.mode).toBe('multi_executor');
    if (strategy.mode !== 'multi_executor') throw new Error('expected multi_executor');
    expect(strategy.workUnits.map(unit => unit.id)).toEqual([
      'wu_research',
      'wu_implementation',
      'wu_review',
    ]);
    expect(strategy.workUnits.find(unit => unit.id === 'wu_implementation')?.dependsOn).toEqual(['wu_research']);
    expect(strategy.workUnits.find(unit => unit.id === 'wu_review')?.dependsOn).toEqual(['wu_implementation']);
    expect(strategy.aggregation.mode).toBe('verify_and_summarize');
    expect(strategy.aggregation.conflictPolicy).toBe('flag_conflicts');
  });

  it('adds an independent review work unit for repo mutation with high-risk validation', () => {
    const strategy = new ExecutionStrategyPlanner().plan({
      task: createTask(),
      userPrompt: '大规模重构任务系统代码，完成后做独立评审和测试验收',
      executionPlan: createExecutionPlan(),
      routeDecision: createRouteDecision({
        selectedExecutor: 'codex-cli',
        primaryIntent: 'repo_execution',
        matchedBoundary: ['repo_mutation', 'refactor', 'code_review'],
      }),
      retrievedTasks: [],
      resources: [],
    });

    expect(strategy.mode).toBe('multi_executor');
    if (strategy.mode !== 'multi_executor') throw new Error('expected multi_executor');
    expect(strategy.workUnits.some(unit => unit.expectedOutput === 'patch')).toBe(true);
    const review = strategy.workUnits.find(unit => unit.expectedOutput === 'review');
    expect(review).toBeDefined();
    expect(review?.riskLevel).toBe('high');
    expect(review?.acceptance.join(' ')).toContain('pass');
  });

  it('honors explicit multi-agent requests even when the task is otherwise simple', () => {
    const strategy = new ExecutionStrategyPlanner().plan({
      task: createTask(),
      userPrompt: '让不同 agent 分别给我两个方案再综合',
      executionPlan: createExecutionPlan(),
      routeDecision: createRouteDecision({
        selectedExecutor: 'deepseek-tui',
        primaryIntent: 'technical_reasoning',
        matchedBoundary: ['reasoning'],
      }),
      retrievedTasks: [],
      resources: [],
    });

    expect(strategy.mode).toBe('multi_executor');
    if (strategy.mode !== 'multi_executor') throw new Error('expected multi_executor');
    expect(strategy.reason).toContain('用户显式要求多 agent');
    expect(strategy.workUnits.length).toBeGreaterThanOrEqual(1);
    expect(strategy.aggregation.mode).toBe('summarize');
  });

  it('uses multi-source synthesis as a supporting signal without forcing multi-executor by itself', () => {
    const strategy = new ExecutionStrategyPlanner().plan({
      task: createTask(),
      userPrompt: '整理历史任务里的 Phoenix 结论',
      executionPlan: createExecutionPlan(),
      routeDecision: createRouteDecision({
        selectedExecutor: 'codex-cli',
        primaryIntent: 'general',
        matchedBoundary: [],
      }),
      retrievedTasks: [createRetrievedTask('task_a'), createRetrievedTask('task_b')],
      resources: [],
    });

    expect(strategy).toMatchObject({
      mode: 'single_executor',
      executorName: 'codex-cli',
    });
  });
});
