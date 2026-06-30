import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
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

  it('prioritizes an auto-resumed ready task ahead of a later normal ready task', () => {
    const resumedTask = taskEngine.create({ title: '自动恢复的挂起任务', goal: '继续主线任务' });
    taskEngine['taskRepo'].update(resumedTask.id, {
      prioritySignals: {
        dueAt: null,
        isReady: true,
        progressRatio: 0.1,
        blocksOthers: false,
        idleHours: 0,
      },
      lastInterruptionReason: '等待恢复',
      lastSchedulingReason: '挂起任务满足执行条件，恢复进入待调度队列',
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
    expect(prioritized[0]?.reasons).toContain('挂起任务已满足执行条件，恢复连续性收益最高');
  });

  it('prioritizes semantically urgent tasks ahead of other auto-resumed parked tasks', () => {
    const normalParked = taskEngine.create({ title: '中国谁做 harness 做的最好？', goal: '调研中国 harness 项目' });
    taskEngine['taskRepo'].update(normalParked.id, {
      prioritySignals: {
        dueAt: null,
        isReady: true,
        progressRatio: 0.1,
        blocksOthers: false,
        idleHours: 0,
        semanticPriority: 'normal',
        semanticPriorityReason: '顺序执行即可',
      },
      lastSchedulingReason: '挂起任务满足执行条件，恢复进入待调度队列',
    });
    taskEngine.transition(normalParked.id, 'ready');

    const urgentInserted = taskEngine.create({
      title: '插入一个紧急任务啊，美国有没有 harness 做的比较好的项目？',
      goal: '插入一个紧急任务啊，美国有没有 harness 做的比较好的项目？',
    });
    taskEngine['taskRepo'].update(urgentInserted.id, {
      prioritySignals: {
        dueAt: null,
        isReady: true,
        progressRatio: 0.1,
        blocksOthers: false,
        idleHours: 0,
        semanticPriority: 'urgent',
        semanticPriorityReason: '用户语义上要求插队处理临时紧急任务',
      },
      lastSchedulingReason: '挂起任务满足执行条件，恢复进入待调度队列',
    });
    taskEngine.transition(urgentInserted.id, 'ready');

    const prioritized = orchestration.getPrioritizedTasks();

    expect(prioritized[0]?.task.id).toBe(urgentInserted.id);
    expect(prioritized[0]?.reasons).toContain('语义优先级：用户语义上要求插队处理临时紧急任务');
  });
});
