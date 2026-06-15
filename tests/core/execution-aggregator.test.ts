import { describe, expect, it } from 'vitest';
import { ExecutionAggregator } from '../../src/core/execution-aggregator.js';
import type { AggregationPlan, ExecutionWorkUnit } from '../../src/core/execution-strategy-planner.js';
import type { WorkUnitResult } from '../../src/core/multi-executor-orchestrator.js';

function createUnit(overrides: Partial<ExecutionWorkUnit>): ExecutionWorkUnit {
  return {
    id: 'wu_test',
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

function createResult(overrides: Partial<WorkUnitResult>): WorkUnitResult {
  return {
    workUnitId: 'wu_test',
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
      workUnits: [
        createUnit({ id: 'wu_research', expectedOutput: 'analysis' }),
        createUnit({ id: 'wu_implementation', expectedOutput: 'patch' }),
      ],
      results: [
        createResult({
          workUnitId: 'wu_research',
          executorName: 'hermes-agent',
          output: '来源: internal docs. Key finding: use FTS first.',
        }),
        createResult({
          workUnitId: 'wu_implementation',
          executorName: 'codex-cli',
          output: 'Changed docs/task-os.md. npm test -- tests/core/execution-aggregator.test.ts',
          artifacts: ['docs/task-os.md'],
        }),
      ],
      aggregation: createAggregationPlan(),
    });

    expect(result.status).toBe('pass');
    expect(result.artifacts).toEqual(['docs/task-os.md']);
    expect(result.finalOutput).toContain('Verification: pass');
    expect(result.finalOutput).toContain('wu_research');
    expect(result.finalOutput).toContain('wu_implementation');
  });

  it('flags conflicting work unit outputs', () => {
    const result = new ExecutionAggregator().aggregate({
      workUnits: [
        createUnit({ id: 'wu_a', expectedOutput: 'analysis' }),
        createUnit({ id: 'wu_b', expectedOutput: 'analysis' }),
      ],
      results: [
        createResult({ workUnitId: 'wu_a', output: '来源: A. conclusion conflict with B.' }),
        createResult({ workUnitId: 'wu_b', output: '来源: B. conclusion contradict A.' }),
      ],
      aggregation: createAggregationPlan(),
    });

    expect(result.status).toBe('concerns');
    expect(result.concerns.some(concern => concern.message.includes('冲突'))).toBe(true);
    expect(result.finalOutput).toContain('Verification: concerns');
  });

  it('flags missing artifact paths for artifact work units', () => {
    const result = new ExecutionAggregator().aggregate({
      workUnits: [
        createUnit({ id: 'wu_artifact', expectedOutput: 'artifact' }),
      ],
      results: [
        createResult({ workUnitId: 'wu_artifact', output: '已生成最终方案，但没有返回路径。' }),
      ],
      aggregation: createAggregationPlan(),
    });

    expect(result.status).toBe('concerns');
    expect(result.concerns[0]).toMatchObject({
      workUnitId: 'wu_artifact',
      severity: 'warning',
    });
    expect(result.concerns[0]?.message).toContain('文件路径');
  });

  it('flags patch work units that do not mention tests or a tests-not-run reason', () => {
    const result = new ExecutionAggregator().aggregate({
      workUnits: [
        createUnit({ id: 'wu_patch', expectedOutput: 'patch' }),
      ],
      results: [
        createResult({ workUnitId: 'wu_patch', output: 'Changed src/core/foo.ts.' }),
      ],
      aggregation: createAggregationPlan(),
    });

    expect(result.status).toBe('concerns');
    expect(result.concerns[0]?.message).toContain('测试命令');
  });

  it('flags missing work unit results as errors', () => {
    const result = new ExecutionAggregator().aggregate({
      workUnits: [
        createUnit({ id: 'wu_missing', expectedOutput: 'review' }),
      ],
      results: [],
      aggregation: createAggregationPlan(),
    });

    expect(result.status).toBe('concerns');
    expect(result.concerns[0]).toMatchObject({
      workUnitId: 'wu_missing',
      severity: 'error',
    });
  });
});
