import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { exitCommand, attachCommand } from '../../src/commands/global-commands.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/core/orchestration.js';
import type { Config } from '../../src/core/types.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: {
      command: 'codex',
      timeout: 60_000,
    },
    orchestration: {
      reminder_enabled: true,
      reminder_throttle: 3600,
      top_k_preferences: 5,
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
  };
}

describe('exitCommand', () => {
  it('应返回 exit 类型', async () => {
    const result = await exitCommand.execute([], {} as any);
    expect(result.type).toBe('exit');
  });

  it('名称为 exit，别名包含 quit 和 q', () => {
    expect(exitCommand.name).toBe('exit');
    expect(exitCommand.aliases).toContain('quit');
    expect(exitCommand.aliases).toContain('q');
  });

  it('supports attaching multiple files to the current task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const task = taskEngine.create({ title: 'Phoenix 周报', goal: '整理 Phoenix 周报' });

    const result = await attachCommand.execute(
      ['file-a.md', 'file-b.md'],
      {
        taskEngine,
        memoryEngine: new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db)),
        orchestration: new OrchestrationEngine(taskEngine),
        executor: {} as any,
        currentTaskId: task.id,
        db,
        config: createConfig(),
      },
    );

    const updatedTask = taskRepo.findById(task.id)!;
    expect(updatedTask.resources).toEqual(['file-a.md', 'file-b.md']);
    expect(result.content).toContain(`任务 #${task.id}`);
    expect(result.content).toContain('2 个文件');
  });

  it('supports attaching files to an explicit task id even without current task focus', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const task = taskEngine.create({ title: '起诉材料补齐', goal: '继续补齐起诉材料' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: '等待客户补充证据文件',
      status: 'waiting',
    });

    const result = await attachCommand.execute(
      [task.id, 'evidence-a.pdf', 'evidence-b.pdf'],
      {
        taskEngine,
        memoryEngine: new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db)),
        orchestration: new OrchestrationEngine(taskEngine),
        executor: {} as any,
        currentTaskId: null,
        db,
        config: createConfig(),
      },
    );

    const updatedTask = taskRepo.findById(task.id)!;
    expect(updatedTask.resources).toEqual(['evidence-a.pdf', 'evidence-b.pdf']);
    expect(result.content).toContain(`任务 #${task.id}`);
    expect(result.content).toContain('仍为 BLOCKED');
    expect(result.content).toContain(`/task ${task.id} unblock`);
  });
});
