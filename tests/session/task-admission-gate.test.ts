import { describe, expect, it } from 'vitest';
import type { IntentDecisionV2 } from '../../src/core/intent-orchestrator.js';
import type { Task } from '../../src/core/types.js';
import { TaskAdmissionGate } from '../../src/session/task-admission-gate.js';

function runningTask(id = 'task_running'): Task {
  return {
    id,
    title: 'active task',
    goal: 'do active work',
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
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
  };
}

function decision(overrides: Partial<IntentDecisionV2>): IntentDecisionV2 {
  return {
    interactionType: 'durable_task',
    confidence: 0.9,
    reason: 'test',
    clarificationQuestion: null,
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    task: { binding: 'new', taskId: null, control: 'none', scope: null },
    execution: {
      mode: 'single_executor',
      complexity: 'simple',
      selectedExecutor: 'codex-cli',
      candidateExecutors: ['codex-cli'],
      requiresVerification: true,
      canModifyFiles: true,
      requiresExternalGateway: false,
      capabilityClass: 'general',
      matchedBoundary: [],
    },
    hints: [],
    ...overrides,
  };
}

describe('TaskAdmissionGate', () => {
  it('rejects a new top-level task while another task is running', () => {
    const gate = new TaskAdmissionGate();
    const result = gate.evaluateIntent({
      decision: decision({ interactionType: 'durable_task' }),
      runningTask: runningTask(),
    });

    expect(result.allowed).toBe(false);
    expect(result.lines.join('\n')).toContain('单活跃任务限制');
    expect(result.lines.join('\n')).toContain('#task_running');
  });

  it('allows task status queries while a task is running', () => {
    const gate = new TaskAdmissionGate();
    const result = gate.evaluateIntent({
      decision: decision({
        interactionType: 'task_control',
        task: { binding: 'none', taskId: null, control: 'status_query', scope: 'running' },
        execution: {
          ...decision({}).execution,
          mode: 'none',
          requiresVerification: false,
        },
      }),
      runningTask: runningTask(),
    });

    expect(result.allowed).toBe(true);
  });

  it('blocks execution preparation for a different top-level task', () => {
    const gate = new TaskAdmissionGate();
    const result = gate.evaluateExecution({
      taskId: 'task_other',
      runningTask: runningTask('task_active'),
    });

    expect(result.allowed).toBe(false);
    expect(result.lines.join('\n')).toContain('#task_active');
    expect(result.lines.join('\n')).toContain('#task_other');
  });

  it('allows execution preparation for the same active task', () => {
    const gate = new TaskAdmissionGate();

    expect(gate.evaluateExecution({
      taskId: 'task_active',
      runningTask: runningTask('task_active'),
    }).allowed).toBe(true);
  });
});
