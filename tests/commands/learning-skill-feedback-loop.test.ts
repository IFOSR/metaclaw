import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { learningCommand } from '../../src/commands/learning-commands.js';
import { SkillUsageEventRepo } from '../../src/storage/skill-usage-event-repo.js';
import { LearningCandidateRepo } from '../../src/storage/learning-candidate-repo.js';
import { ReflectionEventRepo } from '../../src/storage/reflection-event-repo.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function context(db: Database.Database, updateSkill = vi.fn()) {
  return {
    db,
    executor: {
      name: 'codex-cli',
      execute: vi.fn(),
      isAvailable: vi.fn(),
      abort: vi.fn(),
      updateSkill,
    },
  } as any;
}

describe('learning skill feedback loop', () => {
  it('turns runtime skill feedback into patch candidates and supports approve/promote aliases', async () => {
    const db = createDb();
    new SkillUsageEventRepo(db).insert({
      id: 'sue_feedback_1',
      taskId: 'task_feedback_1',
      executionId: 'exec_feedback_1',
      executorName: 'codex-cli',
      skillName: 'tdd-implementation',
      skillVersion: '1.0.0',
      eventType: 'skill_suggested_patch',
      message: '以后这个 Skill 要先写失败测试并确认 RED，再实现代码。',
      payload: {
        suggestedPatch: 'Add RED verification before implementation.',
        targetSkill: 'tdd-implementation',
      },
      createdAt: '2026-05-21T01:00:00.000Z',
    });

    const feedback = await learningCommand.execute(['skill-feedback'], context(db));
    expect(feedback.content).toContain('已生成 Skill Runtime Feedback');

    const candidateRepo = new LearningCandidateRepo(db);
    const candidate = candidateRepo.listPending()[0];
    expect(candidate).toMatchObject({
      kind: 'skill_patch',
      sourceTaskId: 'task_feedback_1',
      safetyStatus: 'passed',
    });
    expect(candidate.content).toContain('先写失败测试');
    expect(new ReflectionEventRepo(db).findById(candidate.sourceReflectionId!)).toMatchObject({
      sourceType: 'executor_skill_usage',
      sourceId: 'sue_feedback_1',
    });

    const list = await learningCommand.execute(['patch', 'candidates'], context(db));
    expect(list.content).toContain('Skill Patch Candidates');
    expect(list.content).toContain(candidate.id);

    const approve = await learningCommand.execute(['patch', 'approve', candidate.id], context(db));
    expect(approve.content).toContain('已批准 Skill Patch Candidate');

    const updateSkill = vi.fn().mockResolvedValue({
      ok: true,
      executorName: 'codex-cli',
      installedSkillName: 'tdd-implementation',
      installedVersion: '1.0.1',
      message: 'updated',
    });
    const promote = await learningCommand.execute(['patch', 'promote', candidate.id], context(db, updateSkill));
    expect(promote.content).toContain('已下发并更新 Skill');
    expect(updateSkill).toHaveBeenCalledTimes(1);
    expect(candidateRepo.findById(candidate.id)?.status).toBe('promoted');
  });
});
