import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { SkillEffectSummaryRepo } from '../../src/storage/skill-effect-summary-repo.js';
import { SkillGovernanceEngine } from '../../src/core/skill-governance-engine.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function recordUsage(repo: SkillEffectSummaryRepo, eventType: 'skill_completed' | 'skill_failed' | 'skill_suggested_patch', index: number) {
  repo.recordUsage({
    executorName: 'mock-executor',
    skillName: 'fragile-skill',
    skillVersion: '1.0.0',
    eventType,
    helpful: eventType === 'skill_completed',
    patchCandidateCreated: eventType === 'skill_suggested_patch',
    failureReason: eventType === 'skill_failed' ? 'same failure repeats' : null,
    usedAt: `2026-04-27T04:${String(index).padStart(2, '0')}:00Z`,
  });
}

describe('Phase E6 skill governance engine', () => {
  it('generates a skill_disable candidate for repeatedly failing skills without mutating executor state', () => {
    const db = createTestDb();
    const repo = new SkillEffectSummaryRepo(db);
    recordUsage(repo, 'skill_failed', 1);
    recordUsage(repo, 'skill_failed', 2);
    recordUsage(repo, 'skill_failed', 3);
    recordUsage(repo, 'skill_failed', 4);

    const candidates = new SkillGovernanceEngine().review(repo.listTop(10));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: 'skill_disable',
      status: 'pending',
      safetyStatus: 'passed',
      promotedAssetId: 'mock-executor/fragile-skill@1.0.0',
    });
    expect(candidates[0].title).toContain('建议停用 Skill');
    expect(candidates[0].content).toContain('使用次数：4');
    expect(candidates[0].content).toContain('成功率：0%');
    expect(candidates[0].content).toContain('最近失败原因：same failure repeats');
  });

  it('generates a skill_deprecation candidate for low-success skills with repeated patch pressure', () => {
    const db = createTestDb();
    const repo = new SkillEffectSummaryRepo(db);
    recordUsage(repo, 'skill_completed', 1);
    recordUsage(repo, 'skill_failed', 2);
    recordUsage(repo, 'skill_suggested_patch', 3);
    recordUsage(repo, 'skill_suggested_patch', 4);
    recordUsage(repo, 'skill_failed', 5);

    const candidates = new SkillGovernanceEngine().review(repo.listTop(10));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: 'skill_deprecation',
      status: 'pending',
      safetyStatus: 'passed',
      promotedAssetId: 'mock-executor/fragile-skill@1.0.0',
    });
    expect(candidates[0].title).toContain('建议废弃 Skill');
    expect(candidates[0].content).toContain('patch 候选次数：2');
    expect(candidates[0].content).toContain('推荐动作：deprecate');
  });

  it('does not create governance candidates for healthy skills', () => {
    const db = createTestDb();
    const repo = new SkillEffectSummaryRepo(db);
    recordUsage(repo, 'skill_completed', 1);
    recordUsage(repo, 'skill_completed', 2);
    recordUsage(repo, 'skill_completed', 3);

    const candidates = new SkillGovernanceEngine().review(repo.listTop(10));

    expect(candidates).toEqual([]);
  });
});
