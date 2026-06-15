import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { OrchestrationEngine } from '../../src/core/orchestration.js';
import { MemoryEngine } from '../../src/core/memory-engine.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { taskCommand } from '../../src/commands/task-commands.js';
import { TaskSearchIndexRepo } from '../../src/storage/task-search-index-repo.js';
import type { CommandContext } from '../../src/commands/router.js';
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';

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

describe('task index command', () => {
  let db: Database.Database;
  let taskEngine: TaskEngine;
  let context: CommandContext;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const taskRepo = new TaskRepo(db);
    taskEngine = new TaskEngine(taskRepo, resolve(tmpdir(), 'metaclaw-test-snapshots'));
    const orchestration = new OrchestrationEngine(taskEngine);
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: async () => ({ success: true, output: '', exitCode: 0, durationMs: 0 }),
      isAvailable: async () => true,
      abort: () => {},
    };

    context = {
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      currentTaskId: null,
      db,
      config: createConfig(),
    };
  });

  it('rebuilds the task search index from existing task data', async () => {
    const task = taskEngine.create({
      title: 'Nimbus 检索索引方案',
      goal: '保存 Nimbus 检索索引方案到 docs',
    });
    taskEngine['taskRepo'].update(task.id, {
      artifacts: ['docs/nimbus-search-index.md'],
    });

    expect(new TaskSearchIndexRepo(db).count()).toBe(0);

    const result = await taskCommand.execute(['index', 'rebuild'], context);

    expect(result.content).toContain('任务检索索引已重建');
    expect(result.content).toContain('条索引记录');
    expect(new TaskSearchIndexRepo(db).search('Nimbus 检索索引').map(item => item.taskId)).toContain(task.id);
  });

  it('searches the task search index and exposes provenance in command output', async () => {
    const taskSearchIndexRepo = new TaskSearchIndexRepo(db);
    const task = taskEngine.create({
      title: 'Orion 验收报告',
      goal: '输出 Orion 冒烟测试验收报告',
    });
    taskSearchIndexRepo.rebuild();

    const result = await taskCommand.execute(['index', 'search', 'Orion 冒烟测试'], context);

    expect(result.content).toContain('任务检索索引命中');
    expect(result.content).toContain(`#${task.id}`);
    expect(result.content).toContain('[task]');
  });
});
