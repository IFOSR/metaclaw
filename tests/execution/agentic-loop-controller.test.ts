import { describe, expect, it, vi } from 'vitest';
import { AgenticLoopController } from '../../src/execution/agentic-loop-controller.js';
import type { MultiExecutorOrchestrationResult } from '../../src/execution/multi-executor-orchestrator.js';
import type { ExecutionStrategy } from '../../src/core/execution-strategy-planner.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { Task } from '../../src/core/types.js';

function createTask(): Task {
  return {
    id: 'task_agentic_loop',
    title: 'Agentic Loop 测试',
    goal: '验证验收闭环',
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
    createdAt: '2026-06-15T10:00:00.000Z',
    updatedAt: '2026-06-15T10:00:00.000Z',
  };
}

function createExecutor(): ExecutorAdapter {
  return {
    name: 'codex-cli',
    execute: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    abort: vi.fn(),
  };
}

function createStrategy(): Extract<ExecutionStrategy, { mode: 'multi_executor' }> {
  return {
    mode: 'multi_executor',
    reason: 'test',
    workUnits: [{
      id: 'wu_patch',
      title: 'Patch',
      goal: 'Modify code',
      executorHint: 'codex-cli',
      dependsOn: [],
      inputs: { taskId: 'task_agentic_loop', resources: [], recalledTaskIds: [] },
      expectedOutput: 'patch',
      acceptance: ['provide tests'],
      riskLevel: 'high',
    }],
    aggregation: {
      mode: 'verify_and_summarize',
      acceptance: ['provide tests'],
      criteria: [{
        id: 'patch_verified',
        description: 'Patch must be verified',
        requiredEvidence: ['tests'],
        severity: 'must',
        appliesToWorkUnitIds: ['wu_patch'],
      }],
      conflictPolicy: 'flag_conflicts',
      maxIterations: 2,
    },
  };
}

describe('AgenticLoopController', () => {
  it('retries failed acceptance feedback and passes when the next iteration satisfies verification', async () => {
    const orchestrator = {
      run: vi.fn()
        .mockResolvedValueOnce({
          status: 'success',
          results: [{
            workUnitId: 'wu_patch',
            executorName: 'codex-cli',
            status: 'success',
            output: 'Changed src/core/foo.ts',
            artifacts: [],
            startedAt: '2026-06-15T10:00:00.000Z',
            finishedAt: '2026-06-15T10:00:01.000Z',
          }],
        } satisfies MultiExecutorOrchestrationResult)
        .mockResolvedValueOnce({
          status: 'success',
          results: [{
            workUnitId: 'wu_patch',
            executorName: 'codex-cli',
            status: 'success',
            output: 'Changed src/core/foo.ts. npm test -- tests/execution/agentic-loop-controller.test.ts',
            artifacts: [],
            startedAt: '2026-06-15T10:01:00.000Z',
            finishedAt: '2026-06-15T10:01:01.000Z',
          }],
        } satisfies MultiExecutorOrchestrationResult),
    };

    const result = await new AgenticLoopController().run({
      strategy: createStrategy(),
      task: createTask(),
      userPrompt: '修复代码并确保测试通过',
      executors: new Map(),
      defaultExecutor: createExecutor(),
      orchestrator,
    });

    expect(result.status).toBe('pass');
    expect(result.iterations).toBe(2);
    expect(orchestrator.run).toHaveBeenCalledTimes(2);
    expect(orchestrator.run.mock.calls[1]?.[0].strategy.workUnits[0].goal).toContain('Agentic loop feedback');
    expect(result.aggregation.finalOutput).toContain('Verification: pass');
  });

  it('blocks when acceptance still fails after the maximum number of iterations', async () => {
    const orchestrator = {
      run: vi.fn().mockResolvedValue({
        status: 'success',
        results: [{
          workUnitId: 'wu_patch',
          executorName: 'codex-cli',
          status: 'success',
          output: 'Changed src/core/foo.ts',
          artifacts: [],
          startedAt: '2026-06-15T10:00:00.000Z',
          finishedAt: '2026-06-15T10:00:01.000Z',
        }],
      } satisfies MultiExecutorOrchestrationResult),
    };

    const result = await new AgenticLoopController().run({
      strategy: createStrategy(),
      task: createTask(),
      userPrompt: '修复代码并确保测试通过',
      executors: new Map(),
      defaultExecutor: createExecutor(),
      orchestrator,
    });

    expect(result.status).toBe('blocked');
    expect(result.iterations).toBe(2);
    expect(result.blockedReason).toContain('最大 agentic loop 迭代次数');
    expect(result.aggregation.retryFeedback[0]?.feedback).toContain('patch_verified');
  });
});
