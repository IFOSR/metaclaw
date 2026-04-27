import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryEngine } from '../../src/core/memory-engine.js';
import { learningCommand } from '../../src/commands/learning-commands.js';
import { LearningCandidateRepo } from '../../src/storage/learning-candidate-repo.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('learningCommand review UX', () => {
  it('lists pending learning candidates and supports approve/reject review actions', async () => {
    const db = createTestDb();
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const repo = new LearningCandidateRepo(db);

    repo.insert({
      id: 'lc_review_1',
      kind: 'skill',
      status: 'pending',
      title: '复用飞书截断调试流程',
      content: '先定位发送层 chunking，再做端到端验证。',
      sourceReflectionId: null,
      sourceTaskId: 'task_1',
      safetyStatus: 'passed',
      safetyReasons: [],
      reviewNote: null,
      promotedAssetId: null,
      createdAt: '2026-04-27T00:00:00Z',
      updatedAt: '2026-04-27T00:00:00Z',
    });

    const list = await learningCommand.execute(['candidates'], { db, memoryEngine } as any);
    expect(list.content).toContain('待审核学习候选');
    expect(list.content).toContain('lc_review_1');
    expect(list.content).toContain('复用飞书截断调试流程');

    const approve = await learningCommand.execute(['approve', 'lc_review_1', '确认可沉淀'], { db, memoryEngine } as any);
    expect(approve.content).toContain('已批准学习候选');
    expect(repo.findById('lc_review_1')?.status).toBe('approved');

    const empty = await learningCommand.execute(['candidates'], { db, memoryEngine } as any);
    expect(empty.content).toContain('暂无待审核学习候选');
  });
});
