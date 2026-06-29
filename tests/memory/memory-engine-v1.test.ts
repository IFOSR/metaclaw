import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { resolve } from 'path';
import { tmpdir } from 'os';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('MemoryEngine V1 lifecycle', () => {
  let engine: MemoryEngine;
  let taskEngine: TaskEngine;

  beforeEach(() => {
    const db = createTestDb();
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    engine = new MemoryEngine(prefRepo, obsRepo);
    taskEngine = new TaskEngine(new TaskRepo(db), resolve(tmpdir(), 'metaclaw-test-snapshots'));
  });

  it('records usage and updates lastUsedAt for confirmed preferences', () => {
    const pref = engine.addManual({
      content: '张总用正式语气',
      scope: 'global',
      type: 'style',
    });
    const task = taskEngine.create({ title: '测试任务', goal: '验证 usage 记录' });

    engine.recordUsage(pref.id, task.id);

    const updated = engine.list().find((item) => item.id === pref.id);
    expect(updated?.lastUsedAt).not.toBeNull();
  });
});
