import { describe, expect, it, vi } from 'vitest';
import { MultiExecutorOrchestrator } from '../../src/execution/multi-executor-orchestrator.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { ExecutionStrategy } from '../../src/core/execution-strategy-planner.js';
import type { Task } from '../../src/core/types.js';

function createTask(): Task {
  return {
    id: 'task_multi_executor',
    title: '多执行器编排测试',
    goal: '验证 work unit 编排',
    status: 'running',
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
  };
}

function createExecutor(name: string, output: string, success = true): ExecutorAdapter {
  return {
    name,
    execute: vi.fn().mockResolvedValue({
      success,
      output,
      error: success ? undefined : output,
      exitCode: success ? 0 : 1,
      durationMs: 1,
    }),
    isAvailable: vi.fn().mockResolvedValue(true),
    abort: vi.fn(),
  };
}

function createStrategy(workUnits: ExecutionStrategy extends infer T
  ? T extends { mode: 'multi_executor'; workUnits: infer W } ? W : never
  : never): Extract<ExecutionStrategy, { mode: 'multi_executor' }> {
  return {
    mode: 'multi_executor',
    reason: 'test multi strategy',
    workUnits: workUnits as Extract<ExecutionStrategy, { mode: 'multi_executor' }>['workUnits'],
    aggregation: {
      mode: 'verify_and_summarize',
      acceptance: [],
      conflictPolicy: 'flag_conflicts',
    },
  };
}

describe('MultiExecutorOrchestrator', () => {
  it('runs sequential work units according to dependencies', async () => {
    const researchExecutor = createExecutor('hermes-agent', 'research output docs/research.md');
    const implementationExecutor = createExecutor('codex-cli', 'implementation output docs/patch.md');
    const strategy = createStrategy([
      {
        id: 'wu_research',
        title: 'Research',
        goal: 'Research first',
        executorHint: 'hermes-agent',
        dependsOn: [],
        inputs: { taskId: 'task_multi_executor', resources: [], recalledTaskIds: [] },
        expectedOutput: 'analysis',
        acceptance: ['research done'],
        riskLevel: 'medium',
      },
      {
        id: 'wu_implementation',
        title: 'Implementation',
        goal: 'Implement after research',
        executorHint: 'codex-cli',
        dependsOn: ['wu_research'],
        inputs: { taskId: 'task_multi_executor', resources: [], recalledTaskIds: [] },
        expectedOutput: 'patch',
        acceptance: ['patch done'],
        riskLevel: 'medium',
      },
    ]);

    const result = await new MultiExecutorOrchestrator().run({
      strategy,
      task: createTask(),
      userPrompt: '先调研再实现',
      executors: new Map([
        ['hermes-agent', researchExecutor],
        ['codex-cli', implementationExecutor],
      ]),
      defaultExecutor: implementationExecutor,
    });

    expect(result.status).toBe('success');
    expect(result.results.map(item => item.workUnitId)).toEqual(['wu_research', 'wu_implementation']);
    expect((researchExecutor.execute as any).mock.invocationCallOrder[0]).toBeLessThan(
      (implementationExecutor.execute as any).mock.invocationCallOrder[0],
    );
    expect(result.results[0]?.artifacts).toContain('docs/research.md');
  });

  it('runs independent fan-out work units in the same orchestration batch', async () => {
    const leftExecutor = createExecutor('hermes-agent', 'left analysis');
    const rightExecutor = createExecutor('pi-agent', 'right analysis');
    const strategy = createStrategy([
      {
        id: 'wu_left',
        title: 'Left',
        goal: 'Left analysis',
        executorHint: 'hermes-agent',
        dependsOn: [],
        inputs: { taskId: 'task_multi_executor', resources: [], recalledTaskIds: [] },
        expectedOutput: 'analysis',
        acceptance: [],
        riskLevel: 'low',
      },
      {
        id: 'wu_right',
        title: 'Right',
        goal: 'Right analysis',
        executorHint: 'pi-agent',
        dependsOn: [],
        inputs: { taskId: 'task_multi_executor', resources: [], recalledTaskIds: [] },
        expectedOutput: 'analysis',
        acceptance: [],
        riskLevel: 'low',
      },
    ]);

    const result = await new MultiExecutorOrchestrator().run({
      strategy,
      task: createTask(),
      userPrompt: '并行分析两个方向',
      executors: new Map([
        ['hermes-agent', leftExecutor],
        ['pi-agent', rightExecutor],
      ]),
      defaultExecutor: leftExecutor,
    });

    expect(result.status).toBe('success');
    expect(result.results.map(item => item.workUnitId).sort()).toEqual(['wu_left', 'wu_right']);
    expect(leftExecutor.execute).toHaveBeenCalledTimes(1);
    expect(rightExecutor.execute).toHaveBeenCalledTimes(1);
  });

  it('blocks the main orchestration when a work unit fails', async () => {
    const failingExecutor = createExecutor('codex-cli', 'test failure', false);
    const strategy = createStrategy([
      {
        id: 'wu_implementation',
        title: 'Implementation',
        goal: 'Implement',
        executorHint: 'codex-cli',
        dependsOn: [],
        inputs: { taskId: 'task_multi_executor', resources: [], recalledTaskIds: [] },
        expectedOutput: 'patch',
        acceptance: [],
        riskLevel: 'high',
      },
    ]);

    const result = await new MultiExecutorOrchestrator().run({
      strategy,
      task: createTask(),
      userPrompt: '实现并测试',
      executors: new Map([['codex-cli', failingExecutor]]),
      defaultExecutor: failingExecutor,
    });

    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toContain('wu_implementation failed');
    expect(result.results[0]).toMatchObject({
      workUnitId: 'wu_implementation',
      status: 'failed',
    });
  });

  it('uses the default executor when a hinted executor is unavailable in the registry', async () => {
    const defaultExecutor = createExecutor('codex-cli', 'fallback output');
    const strategy = createStrategy([
      {
        id: 'wu_unknown',
        title: 'Unknown executor unit',
        goal: 'Run through fallback',
        executorHint: 'missing-agent',
        dependsOn: [],
        inputs: { taskId: 'task_multi_executor', resources: [], recalledTaskIds: [] },
        expectedOutput: 'summary',
        acceptance: [],
        riskLevel: 'low',
      },
    ]);

    const result = await new MultiExecutorOrchestrator().run({
      strategy,
      task: createTask(),
      userPrompt: '执行未知 executor work unit',
      executors: new Map(),
      defaultExecutor,
    });

    expect(result.status).toBe('success');
    expect(result.results[0]?.executorName).toBe('codex-cli');
    expect(defaultExecutor.execute).toHaveBeenCalledTimes(1);
  });
});
