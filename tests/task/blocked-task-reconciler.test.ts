import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/core/types.js';
import { reconcileBlockedTasksFromInput } from '../../src/task/blocked-task-reconciler.js';

function blockedTask(input: Partial<Task> & { id: string; goal: string; dependency: string }): Task {
  const now = new Date().toISOString();
  return {
    id: input.id,
    title: input.title ?? input.goal,
    goal: input.goal,
    status: 'blocked',
    summary: '',
    snapshots: [],
    resources: [],
    artifacts: [],
    dependencies: [{
      taskId: input.id,
      type: 'manual',
      description: input.dependency,
      status: 'waiting',
      createdAt: now,
    }],
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
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

describe('reconcileBlockedTasksFromInput', () => {
  it('resumes a single network-blocked task when the user says network recovered', () => {
    const task = blockedTask({
      id: 'task_network',
      goal: '继续调研飞书 Client API',
      dependency: '执行器网络连接失败，请检查网络或代理配置',
    });

    const decision = reconcileBlockedTasksFromInput([task], '网络恢复了，继续飞书 Client API 任务');

    expect(decision?.task.id).toBe(task.id);
    expect(decision?.reason).toContain('可恢复故障');
  });

  it('does not auto-resume ambiguous blocked tasks', () => {
    const first = blockedTask({
      id: 'task_a',
      goal: '整理飞书 Client API',
      dependency: '等待材料',
    });
    const second = blockedTask({
      id: 'task_b',
      goal: '整理飞书权限清单',
      dependency: '等待材料',
    });

    const decision = reconcileBlockedTasksFromInput([first, second], '我补充一下飞书材料：需要 tenant_access_token');

    expect(decision).toBeNull();
  });
});
