import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { OrchestrationEngine } from '../../src/core/orchestration.js';
import { tmpdir } from 'os';
import { resolve } from 'path';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('OrchestrationEngine', () => {
  let orchestration: OrchestrationEngine;
  let taskEngine: TaskEngine;

  beforeEach(() => {
    const db = createTestDb();
    const repo = new TaskRepo(db);
    taskEngine = new TaskEngine(repo, resolve(tmpdir(), 'metaclaw-test-snapshots'));
    orchestration = new OrchestrationEngine(taskEngine);
  });

  it('should generate empty dashboard', () => {
    const dashboard = orchestration.getDashboard();
    expect(dashboard.summary.active).toBe(0);
    expect(dashboard.summary.blocked).toBe(0);
    expect(dashboard.priorityTask).toBeNull();
  });

  it('should show active tasks in dashboard', () => {
    taskEngine.create({ title: '任务A', goal: '目标A' });
    taskEngine.create({ title: '任务B', goal: '目标B' });

    const dashboard = orchestration.getDashboard();
    expect(dashboard.summary.active).toBe(2);
  });

  it('should prioritize ready tasks', () => {
    const t1 = taskEngine.create({ title: '任务A', goal: '目标A' });
    taskEngine.transition(t1.id, 'ready');

    const t2 = taskEngine.create({ title: '任务B', goal: '目标B' });
    taskEngine.transition(t2.id, 'ready');

    const prioritized = orchestration.getPrioritizedTasks();
    expect(prioritized.length).toBe(2);
    expect(prioritized[0].score.total).toBeGreaterThanOrEqual(0);
  });

  it('should show blocked tasks with reasons', () => {
    const t = taskEngine.create({ title: '任务A', goal: '目标A' });
    taskEngine.transition(t.id, 'ready');
    taskEngine.transition(t.id, 'running');
    taskEngine.block(t.id, {
      taskId: t.id,
      type: 'manual',
      description: '等待客户资料',
      status: 'waiting',
    });

    const blocked = orchestration.getBlockedTasks();
    expect(blocked).toHaveLength(1);
    expect(blocked[0].blockReason).toBe('等待客户资料');
  });

  it('should suggest next task after completion', () => {
    const t1 = taskEngine.create({ title: '任务A', goal: '目标A' });
    taskEngine.transition(t1.id, 'ready');

    const t2 = taskEngine.create({ title: '任务B', goal: '目标B' });
    taskEngine.transition(t2.id, 'ready');
    taskEngine.transition(t2.id, 'running');
    taskEngine.transition(t2.id, 'done');

    const suggestion = orchestration.suggestNext(t2.id);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.taskId).toBe(t1.id);
  });

  it('prioritizes a preempted-and-resumed ready task ahead of a later normal ready task', () => {
    const resumedTask = taskEngine.create({ title: '被抢占后恢复的任务', goal: '继续主线任务' });
    taskEngine['taskRepo'].update(resumedTask.id, {
      prioritySignals: {
        dueAt: null,
        isReady: true,
        progressRatio: 0.1,
        blocksOthers: false,
        idleHours: 0,
      },
      lastInterruptionReason: '被更高优先级任务抢占：插入紧急任务',
      lastSchedulingReason: '高优任务完成，恢复进入待调度队列',
    });
    taskEngine.transition(resumedTask.id, 'ready');

    const normalTask = taskEngine.create({ title: '后续普通任务', goal: '处理后续事项' });
    taskEngine['taskRepo'].update(normalTask.id, {
      prioritySignals: {
        dueAt: null,
        isReady: true,
        progressRatio: 0.6,
        blocksOthers: false,
        idleHours: 0,
      },
    });
    taskEngine.transition(normalTask.id, 'ready');

    const prioritized = orchestration.getPrioritizedTasks();

    expect(prioritized[0]?.task.id).toBe(resumedTask.id);
    expect(prioritized[0]?.reasons).toContain('刚被高优任务打断，恢复连续性收益最高');
  });
});
