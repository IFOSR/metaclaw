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

function insertCandidate(repo: LearningCandidateRepo, overrides: Partial<Parameters<LearningCandidateRepo['insert']>[0]> = {}) {
  repo.insert({
    id: 'lc_promote_1',
    kind: 'skill',
    status: 'approved',
    title: 'Reusable MetaClaw verification workflow',
    content: 'Run targeted tests, lint, build, and full regression before delivery.',
    sourceReflectionId: null,
    sourceTaskId: 'task_1',
    safetyStatus: 'passed',
    safetyReasons: [],
    reviewNote: null,
    promotedAssetId: null,
    createdAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:00:00.000Z',
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

describe('learningCommand promote UX', () => {
  it('promotes an approved safe skill candidate through executor.installSkill and writes audit', async () => {
    const db = createTestDb();
    const repo = new LearningCandidateRepo(db);
    insertCandidate(repo);
    const installSkill = vi.fn().mockResolvedValue({
      ok: true,
      executorName: 'mock-executor',
      installedSkillName: 'reusable-metaclaw-verification-workflow',
      installedVersion: '1.0.0',
      message: 'installed',
    });

    const result = await learningCommand.execute(['promote', 'lc_promote_1'], commandContext(db, { installSkill }));

    expect(result.content).toContain('已下发并安装');
    expect(installSkill).toHaveBeenCalledTimes(1);
    expect(installSkill.mock.calls[0][0]).toMatchObject({
      candidateId: 'lc_promote_1',
      name: 'reusable-metaclaw-verification-workflow',
    });
    expect(repo.findById('lc_promote_1')?.status).toBe('promoted');
    const audits = new ExecutorSkillInstallEventRepo(db).listByCandidate('lc_promote_1');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ status: 'success', action: 'install', executorName: 'mock-executor' });
  });

  it('records unsupported when executor does not implement installSkill without crashing', async () => {
    const db = createTestDb();
    const repo = new LearningCandidateRepo(db);
    insertCandidate(repo);

    const result = await learningCommand.execute(['promote', 'lc_promote_1'], commandContext(db, {}));

    expect(result.content).toContain('不支持');
    expect(repo.findById('lc_promote_1')?.status).toBe('approved');
    expect(new ExecutorSkillInstallEventRepo(db).listByCandidate('lc_promote_1')[0].status).toBe('unsupported');
  });

  it('blocks rejected, pending, or unsafe candidates before executor install', async () => {
    const db = createTestDb();
    const repo = new LearningCandidateRepo(db);
    insertCandidate(repo, { status: 'pending' });
    const installSkill = vi.fn();

    const result = await learningCommand.execute(['promote', 'lc_promote_1'], commandContext(db, { installSkill }));

    expect(result.content).toContain('不能 promotion');
    expect(installSkill).not.toHaveBeenCalled();
    expect(new ExecutorSkillInstallEventRepo(db).listByCandidate('lc_promote_1')[0].status).toBe('blocked');
  });
});
