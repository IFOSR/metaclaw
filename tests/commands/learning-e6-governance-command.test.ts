import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { learningCommand } from '../../src/commands/learning-commands.js';
import { LearningCandidateRepo } from '../../src/storage/learning-candidate-repo.js';
import { ExecutorSkillInstallEventRepo } from '../../src/storage/executor-skill-install-event-repo.js';
import { SkillEffectSummaryRepo } from '../../src/storage/skill-effect-summary-repo.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function commandContext(db: Database.Database, executor: Partial<ExecutorAdapter> = {}) {
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

function insertGovernanceCandidate(repo: LearningCandidateRepo, kind: 'skill_disable' | 'skill_deprecation') {
  repo.insert({
    id: `lc_${kind}`,
    kind,
    status: 'approved',
    title: kind === 'skill_disable' ? '建议停用 Skill：fragile-skill' : '建议废弃 Skill：fragile-skill',
    content: [
      'Skill Governance Candidate',
      'executor：mock-executor',
      'skill：fragile-skill',
      'version：1.0.0',
      '使用次数：4',
      '成功率：0%',
      `推荐动作：${kind === 'skill_disable' ? 'disable' : 'deprecate'}`,
    ].join('\n'),
    sourceReflectionId: null,
    sourceTaskId: null,
    safetyStatus: 'passed',
    safetyReasons: [],
    reviewNote: null,
    promotedAssetId: 'mock-executor/fragile-skill@1.0.0',
    createdAt: '2026-04-27T04:00:00Z',
    updatedAt: '2026-04-27T04:00:00Z',
  });
}

describe('learningCommand E6 skill governance promotion and review UX', () => {
  it('promotes approved skill_disable candidates through executor.disableSkill and writes governance audit', async () => {
    const db = createTestDb();
    const candidateRepo = new LearningCandidateRepo(db);
    insertGovernanceCandidate(candidateRepo, 'skill_disable');
    const disableSkill = vi.fn().mockResolvedValue({
      ok: true,
      executorName: 'mock-executor',
      installedSkillName: 'fragile-skill',
      installedVersion: '1.0.0',
      message: 'disabled fragile-skill',
    });

    const result = await learningCommand.execute(['promote', 'lc_skill_disable'], commandContext(db, { disableSkill } as any));

    expect(disableSkill).toHaveBeenCalledWith({ skillName: 'fragile-skill', skillVersion: '1.0.0' });
    expect(result.content).toContain('已下发并停用 Skill');
    expect(candidateRepo.findById('lc_skill_disable')?.status).toBe('promoted');
    expect(new ExecutorSkillInstallEventRepo(db).listByCandidate('lc_skill_disable')[0]).toMatchObject({
      action: 'disable',
      status: 'success',
      message: 'disabled fragile-skill',
    });
  });

  it('records unsupported audit for approved skill_deprecation candidates when executor has no deprecateSkill API', async () => {
    const db = createTestDb();
    const candidateRepo = new LearningCandidateRepo(db);
    insertGovernanceCandidate(candidateRepo, 'skill_deprecation');

    const result = await learningCommand.execute(['promote', 'lc_skill_deprecation'], commandContext(db));

    expect(result.content).toContain('不支持 Skill 废弃');
    expect(candidateRepo.findById('lc_skill_deprecation')?.status).toBe('approved');
    expect(new ExecutorSkillInstallEventRepo(db).listByCandidate('lc_skill_deprecation')[0]).toMatchObject({
      action: 'deprecate',
      status: 'unsupported',
    });
  });

  it('highlights high-risk skill summaries in /learning skills and /learning summary', async () => {
    const db = createTestDb();
    const repo = new SkillEffectSummaryRepo(db);
    for (let i = 0; i < 4; i += 1) {
      repo.recordUsage({
        executorName: 'mock-executor',
        skillName: 'fragile-skill',
        skillVersion: '1.0.0',
        eventType: 'skill_failed',
        helpful: false,
        patchCandidateCreated: false,
        failureReason: 'same failure repeats',
        usedAt: `2026-04-27T04:0${i}:00Z`,
      });
    }

    const skills = await learningCommand.execute(['skills'], commandContext(db));
    const summary = await learningCommand.execute(['summary'], commandContext(db));

    expect(skills.content).toContain('高风险');
    expect(skills.content).toContain('建议停用');
    expect(summary.content).toContain('建议治理的 Skill 1');
  });
});
