import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/core/types.js';
import { planTaskExecution } from '../../src/tui/app.js';

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'task_1',
    title: '历史任务',
    goal: '历史目标',
    status: 'done',
    summary: '',
    snapshots: [],
    resources: ['/tmp/report.md'],
    dependencies: [],
    prioritySignals: {
      dueAt: null,
      isReady: true,
      progressRatio: 1,
      blocksOthers: false,
      idleHours: 0,
    },
    injectedPreferences: [],
    createdAt: '2026-04-16T00:00:00Z',
    updatedAt: '2026-04-16T00:00:00Z',
    ...overrides,
  };
}

describe('planTaskExecution', () => {
  it('forks a follow-up task when the referenced task is already done', () => {
    const plan = planTaskExecution(makeTask({ status: 'done' }), '我们之前是不是做了一个调研项目');

    expect(plan.mode).toBe('fork-follow-up');
    expect(plan.transitions).toEqual(['ready', 'running']);
    expect(plan.contextTaskId).toBe('task_1');
    expect(plan.newTaskInput).toEqual({
      title: '我们之前是不是做了一个调研项目',
      goal: '我们之前是不是做了一个调研项目',
      resources: ['/tmp/report.md'],
    });
  });

  it('only transitions ready tasks to running', () => {
    const plan = planTaskExecution(makeTask({ status: 'ready' }), '继续');

    expect(plan.mode).toBe('reuse-existing');
    expect(plan.transitions).toEqual(['running']);
  });

  it('requires unblock before executing blocked tasks', () => {
    const plan = planTaskExecution(makeTask({ status: 'blocked' }), '继续');

    expect(plan.mode).toBe('blocked');
    expect(plan.error).toContain('当前任务已阻塞');
  });
});
