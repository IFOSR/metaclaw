import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryEngine } from '../../src/core/memory-engine.js';
import { memoryCommand } from '../../src/commands/memory-commands.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('memoryCommand', () => {
  let engine: MemoryEngine;

  beforeEach(() => {
    const db = createTestDb();
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    engine = new MemoryEngine(prefRepo, obsRepo);
  });

  it('supports editing an existing preference', async () => {
    const pref = engine.addManual({
      content: '输出用 Markdown 格式',
      scope: 'global',
      type: 'style',
    });

    const result = await memoryCommand.execute(['edit', pref.id, '输出用表格格式'], {
      memoryEngine: engine,
    } as any);

    expect(result.content).toContain('已更新偏好');
    expect(engine.list()[0].content).toBe('输出用表格格式');
  });
});
