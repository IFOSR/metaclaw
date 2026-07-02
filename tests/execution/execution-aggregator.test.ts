import { describe, expect, it } from 'vitest';
import { ExecutionAggregator } from '../../src/execution/execution-aggregator.js';
import type { AggregationPlan, ExecutionSubtask } from '../../src/core/execution-strategy-planner.js';
import type { SubtaskResult } from '../../src/execution/multi-executor-orchestrator.js';

function createUnit(overrides: Partial<ExecutionSubtask>): ExecutionSubtask {
  return {
    id: 'subtask_test',
    title: 'Test unit',
    goal: 'Test goal',
    executorHint: 'codex-cli',
    dependsOn: [],
    inputs: { taskId: 'task_agg', resources: [], recalledTaskIds: [] },
    expectedOutput: 'summary',
    acceptance: [],
    riskLevel: 'low',
    ...overrides,
  };
}

function createResult(overrides: Partial<SubtaskResult>): SubtaskResult {
  return {
    subtaskId: 'subtask_test',
    executorName: 'codex-cli',
    status: 'success',
    output: 'ok',
    artifacts: [],
    startedAt: '2026-06-14T10:00:00.000Z',
    finishedAt: '2026-06-14T10:00:01.000Z',
    ...overrides,
  };
}

function createAggregationPlan(): AggregationPlan {
  return {
    mode: 'verify_and_summarize',
    acceptance: [],
    conflictPolicy: 'flag_conflicts',
  };
}

describe('ExecutionAggregator', () => {
  it('summarizes research and implementation outputs with artifacts when verification passes', () => {
    const result = new ExecutionAggregator().aggregate({
      subtasks: [
        createUnit({ id: 'subtask_research', expectedOutput: 'analysis' }),
        createUnit({ id: 'subtask_implementation', expectedOutput: 'patch' }),
      ],
      results: [
        createResult({
          subtaskId: 'subtask_research',
          executorName: 'hermes-agent',
          output: '来源: internal docs. Key finding: use FTS first.',
        }),
        createResult({
          subtaskId: 'subtask_implementation',
          executorName: 'codex-cli',
          output: 'Changed docs/task-os.md. npm test -- tests/execution/execution-aggregator.test.ts',
          artifacts: ['docs/task-os.md'],
        }),
      ],
      aggregation: createAggregationPlan(),
    });

    expect(result.status).toBe('pass');
    expect(result.artifacts).toEqual(['docs/task-os.md']);
    expect(result.finalOutput).toContain('Verification: pass');
    expect(result.finalOutput).toContain('subtask_research');
    expect(result.finalOutput).toContain('subtask_implementation');
  });

  it('flags conflicting subtask outputs', () => {
    const result = new ExecutionAggregator().aggregate({
      subtasks: [
        createUnit({ id: 'subtask_a', expectedOutput: 'analysis' }),
        createUnit({ id: 'subtask_b', expectedOutput: 'analysis' }),
      ],
      results: [
        createResult({ subtaskId: 'subtask_a', output: '来源: A. conclusion conflict with B.' }),
        createResult({ subtaskId: 'subtask_b', output: '来源: B. conclusion contradict A.' }),
      ],
      aggregation: createAggregationPlan(),
    });

    expect(result.status).toBe('concerns');
    expect(result.concerns.some(concern => concern.message.includes('冲突'))).toBe(true);
    expect(result.finalOutput).toContain('Verification: concerns');
  });

  it('flags missing artifact paths for artifact subtasks', () => {
    const result = new ExecutionAggregator().aggregate({
      subtasks: [
        createUnit({ id: 'subtask_artifact', expectedOutput: 'artifact' }),
      ],
      results: [
        createResult({ subtaskId: 'subtask_artifact', output: '已生成最终方案，但没有返回路径。' }),
      ],
      aggregation: createAggregationPlan(),
    });

    expect(result.status).toBe('concerns');
    expect(result.concerns[0]).toMatchObject({
      subtaskId: 'subtask_artifact',
      severity: 'warning',
    });
    expect(result.concerns[0]?.message).toContain('文件路径');
  });

  it('flags patch subtasks that do not mention tests or a tests-not-run reason', () => {
    const result = new ExecutionAggregator().aggregate({
      subtasks: [
        createUnit({ id: 'subtask_patch', expectedOutput: 'patch' }),
      ],
      results: [
        createResult({ subtaskId: 'subtask_patch', output: 'Changed src/core/foo.ts.' }),
      ],
      aggregation: createAggregationPlan(),
    });

    expect(result.status).toBe('concerns');
    expect(result.concerns[0]?.message).toContain('测试命令');
  });

  it('flags missing subtask results as errors', () => {
    const result = new ExecutionAggregator().aggregate({
      subtasks: [
        createUnit({ id: 'subtask_missing', expectedOutput: 'review' }),
      ],
      results: [],
      aggregation: createAggregationPlan(),
    });

    expect(result.status).toBe('concerns');
    expect(result.concerns[0]).toMatchObject({
      subtaskId: 'subtask_missing',
      severity: 'error',
    });
  });
});
