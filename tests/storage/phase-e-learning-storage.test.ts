import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { LearningCandidateRepo } from '../../src/storage/learning-candidate-repo.js';
import { ReflectionEventRepo } from '../../src/storage/reflection-event-repo.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('Phase E learning storage', () => {
  it('persists reflection events with sanitized evidence payloads', () => {
    const db = createTestDb();
    const repo = new ReflectionEventRepo(db);

    repo.insert({
      id: 'refl_1',
      sourceType: 'task_completion',
      sourceId: 'task_1',
      taskId: 'task_1',
      summary: '任务成功完成，可沉淀复用步骤',
      evidence: { executor: 'hermes', outputSnippet: '已完成并验证' },
      createdAt: '2026-04-27T00:00:00Z',
    });

    const row = repo.findById('refl_1');
    expect(row).not.toBeNull();
    expect(row?.sourceType).toBe('task_completion');
    expect(row?.taskId).toBe('task_1');
    expect(row?.evidence).toEqual({ executor: 'hermes', outputSnippet: '已完成并验证' });
  });

  it('persists learning candidates and supports review lifecycle updates', () => {
    const db = createTestDb();
    const repo = new LearningCandidateRepo(db);

    repo.insert({
      id: 'lc_1',
      kind: 'skill',
      status: 'pending',
      title: '调试 Feishu 输出截断流程',
      content: '遇到飞书输出截断时，先定位发送层 chunking，再验证端到端。',
      sourceReflectionId: 'refl_1',
      sourceTaskId: 'task_1',
      safetyStatus: 'passed',
      safetyReasons: [],
      reviewNote: null,
      promotedAssetId: null,
      createdAt: '2026-04-27T00:00:00Z',
      updatedAt: '2026-04-27T00:00:00Z',
    });

    expect(repo.listPending()).toHaveLength(1);

    repo.updateReview('lc_1', {
      status: 'approved',
      reviewNote: '用户确认可沉淀为 Skill candidate',
      updatedAt: '2026-04-27T00:05:00Z',
    });

    const approved = repo.findById('lc_1');
    expect(approved?.status).toBe('approved');
    expect(approved?.reviewNote).toBe('用户确认可沉淀为 Skill candidate');
    expect(approved?.updatedAt).toBe('2026-04-27T00:05:00Z');
    expect(repo.listPending()).toHaveLength(0);
  });
});
