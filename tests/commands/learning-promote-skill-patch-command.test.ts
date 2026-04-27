import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryEngine } from '../../src/core/memory-engine.js';
import { learningCommand } from '../../src/commands/learning-commands.js';
import { LearningCandidateRepo } from '../../src/storage/learning-candidate-repo.js';
import { ExecutorSkillInstallEventRepo } from '../../src/storage/executor-skill-install-event-repo.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertPatchCandidate(repo: LearningCandidateRepo, overrides: Partial<Parameters<LearningCandidateRepo['insert']>[0]> = {}) {
  repo.insert({
    id: 'lc_patch_promote_1',
    kind: 'skill_patch',
    status: 'approved',
    title: 'Patch systematic-debugging RED confirmation step',
    content: 'Add guidance to confirm RED before production edits.',
    sourceReflectionId: null,
    sourceTaskId: 'task_e4',
    safetyStatus: 'passed',
    safetyReasons: [],
    reviewNote: null,
    promotedAssetId: 'systematic-debugging',
    createdAt: '2026-04-27T02:00:00.000Z',
    updatedAt: '2026-04-27T02:00:00.000Z',
    ...overrides,
  });
}

function commandContext(db: Database.Database, executor: Partial<ExecutorAdapter>) {
  return {
    db,
    memoryEngine: new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db)),
    executor: {
      name: 'mock-executor',
      execute: vi.fn(),
      isAvailable: vi.fn(),
      abort: vi.fn(),
      ...executor,
    },
  } as any;
}

describe('learningCommand promote skill_patch UX', () => {
  it('promotes approved safe skill_patch candidates through executor.updateSkill and writes update audit', async () => {
    const db = createTestDb();
    const repo = new LearningCandidateRepo(db);
    insertPatchCandidate(repo);
    const installSkill = vi.fn();
    const updateSkill = vi.fn().mockResolvedValue({
      ok: true,
      executorName: 'mock-executor',
      installedSkillName: 'systematic-debugging',
      installedVersion: '1.0.1',
      message: 'updated',
    });

    const result = await learningCommand.execute(['promote', 'lc_patch_promote_1'], commandContext(db, { installSkill, updateSkill }));

    expect(result.content).toContain('已下发并更新');
    expect(installSkill).not.toHaveBeenCalled();
    expect(updateSkill).toHaveBeenCalledTimes(1);
    expect(updateSkill.mock.calls[0][0]).toMatchObject({
      candidateId: 'lc_patch_promote_1',
      kind: 'skill_patch',
      name: 'systematic-debugging',
    });
    expect(repo.findById('lc_patch_promote_1')?.status).toBe('promoted');
    const audits = new ExecutorSkillInstallEventRepo(db).listByCandidate('lc_patch_promote_1');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ status: 'success', action: 'update', executorName: 'mock-executor' });
  });

  it('records unsupported when executor does not implement updateSkill for skill_patch candidates', async () => {
    const db = createTestDb();
    const repo = new LearningCandidateRepo(db);
    insertPatchCandidate(repo);

    const result = await learningCommand.execute(['promote', 'lc_patch_promote_1'], commandContext(db, { installSkill: vi.fn() }));

    expect(result.content).toContain('不支持 Skill 更新');
    expect(repo.findById('lc_patch_promote_1')?.status).toBe('approved');
    expect(new ExecutorSkillInstallEventRepo(db).listByCandidate('lc_patch_promote_1')[0]).toMatchObject({
      status: 'unsupported',
      action: 'update',
    });
  });
});
