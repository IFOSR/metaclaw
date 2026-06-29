import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ReflectionEngine } from '../../src/learning/reflection-engine.js';
import { learningCommand } from '../../src/commands/learning-commands.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { LearningCandidateRepo } from '../../src/storage/learning-candidate-repo.js';
import { ReflectionEventRepo } from '../../src/storage/reflection-event-repo.js';
import { ExecutorSkillInstallEventRepo } from '../../src/storage/executor-skill-install-event-repo.js';
import type { SkillUsageEventRecord } from '../../src/storage/skill-usage-event-repo.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function createPatchEvent(overrides: Partial<SkillUsageEventRecord> = {}): SkillUsageEventRecord {
  return {
    id: 'skill_evt_e4_integration',
    taskId: 'task_e4_integration',
    executionId: 'exec_e4_integration',
    executorName: 'claude-code',
    skillName: 'systematic-debugging',
    skillVersion: '1.0.0',
    eventType: 'skill_suggested_patch',
    message: 'Add explicit RED verification before implementation.',
    payload: {
      proposedPatch: '- Always run targeted failing test before production code',
      reason: 'Executor skipped RED confirmation once',
    },
    createdAt: '2026-04-27T03:00:00.000Z',
    ...overrides,
  };
}

function createContext(db: Database.Database, executor: Partial<ExecutorAdapter>) {
  return {
    db,
    memoryEngine: new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db)),
    executor: {
      name: 'claude-code',
      execute: vi.fn(),
      isAvailable: vi.fn(),
      abort: vi.fn(),
      ...executor,
    },
  } as any;
}

describe('Phase E4 skill patch promotion integration', () => {
  it('promotes reviewed safe skill_suggested_patch reflections through updateSkill without installing or selecting skills', async () => {
    const db = createDb();
    const reflection = new ReflectionEngine().reflectOnSkillUsage(createPatchEvent());
    new ReflectionEventRepo(db).insert(reflection.event);
    const candidateRepo = new LearningCandidateRepo(db);
    candidateRepo.insert(reflection.candidate);
    candidateRepo.updateReview(reflection.candidate.id, {
      status: 'approved',
      reviewNote: 'version:1.0.2',
      promotedAssetId: reflection.candidate.promotedAssetId,
      updatedAt: '2026-04-27T03:01:00.000Z',
    });

    const installSkill = vi.fn();
    const updateSkill = vi.fn().mockResolvedValue({
      ok: true,
      executorName: 'claude-code',
      installedSkillName: 'systematic-debugging',
      installedVersion: '1.0.2',
      message: 'updated systematic-debugging',
    });

    const result = await learningCommand.execute(
      ['promote', reflection.candidate.id],
      createContext(db, { name: 'claude-code', installSkill, updateSkill }),
    );

    expect(result.content).toContain('已下发并更新 Skill：systematic-debugging@1.0.2');
    expect(installSkill).not.toHaveBeenCalled();
    expect(updateSkill).toHaveBeenCalledTimes(1);
    expect(updateSkill.mock.calls[0][0]).toMatchObject({
      kind: 'skill_patch',
      name: 'systematic-debugging',
      version: '1.0.2',
      candidateId: reflection.candidate.id,
    });
    expect(candidateRepo.findById(reflection.candidate.id)?.status).toBe('promoted');
    expect(new ExecutorSkillInstallEventRepo(db).listByCandidate(reflection.candidate.id)[0]).toMatchObject({
      action: 'update',
      status: 'success',
      packageId: `pkg_${reflection.candidate.id}`,
    });
  });

  it('blocks unsafe skill_patch content before executor side effects', async () => {
    const db = createDb();
    const reflection = new ReflectionEngine().reflectOnSkillUsage(createPatchEvent({
      message: 'Add token handling step',
      payload: { proposedPatch: 'token=sk-1234567890abcdef1234567890abcdef' },
    }));
    new ReflectionEventRepo(db).insert(reflection.event);
    const candidateRepo = new LearningCandidateRepo(db);
    candidateRepo.insert(reflection.candidate);
    candidateRepo.updateReview(reflection.candidate.id, {
      status: 'approved',
      reviewNote: null,
      updatedAt: '2026-04-27T03:01:00.000Z',
    });
    const updateSkill = vi.fn();

    const result = await learningCommand.execute(
      ['promote', reflection.candidate.id],
      createContext(db, { name: 'claude-code', updateSkill }),
    );

    expect(result.content).toContain('不能 promotion');
    expect(updateSkill).not.toHaveBeenCalled();
    expect(candidateRepo.findById(reflection.candidate.id)?.status).toBe('approved');
    expect(new ExecutorSkillInstallEventRepo(db).listByCandidate(reflection.candidate.id)[0]).toMatchObject({
      action: 'update',
      status: 'blocked',
    });
  });
});
