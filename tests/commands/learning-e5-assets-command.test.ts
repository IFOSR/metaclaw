import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryEngine } from '../../src/core/memory-engine.js';
import { learningCommand } from '../../src/commands/learning-commands.js';
import { LearningCandidateRepo } from '../../src/storage/learning-candidate-repo.js';
import { TaskMemoryCardRepo } from '../../src/storage/task-memory-card-repo.js';
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
      installSkill: vi.fn(),
      updateSkill: vi.fn(),
      ...executor,
    },
  } as any;
}

function insertTaskMemoryCardCandidate(repo: LearningCandidateRepo) {
  repo.insert({
    id: 'lc_card_1',
    kind: 'task_memory_card',
    status: 'approved',
    title: '任务记忆卡：E5 learning assets',
    content: [
      'Task Memory Card',
      '目标：实现 E5 长期学习资产层',
      '摘要：新增任务记忆卡和 skill 效果汇总。',
      '关键决策：Task Memory Card 记录任务事实，不写入 Preference。',
      '修改文件：src/storage/task-memory-card-repo.ts, src/storage/skill-effect-summary-repo.ts',
      '验证命令：npm test -- tests/storage/phase-e5-learning-assets-storage.test.ts; npm run lint',
      '坑点：summary 聚合要按 executor + skill + version。',
      '产物：docs/metaclaw-phase-e-unified-learning-and-executor-skill-evolution.md',
      '结果：success',
    ].join('\n'),
    sourceReflectionId: 'refl_card_1',
    sourceTaskId: 'task_e5_1',
    safetyStatus: 'passed',
    safetyReasons: [],
    reviewNote: null,
    promotedAssetId: null,
    createdAt: '2026-04-27T03:00:00Z',
    updatedAt: '2026-04-27T03:00:00Z',
  });
}

describe('learningCommand E5 learning asset commands', () => {
  it('promotes an approved task_memory_card candidate into task_memory_cards without calling executor skill APIs', async () => {
    const db = createTestDb();
    const candidateRepo = new LearningCandidateRepo(db);
    insertTaskMemoryCardCandidate(candidateRepo);
    const installSkill = vi.fn();
    const updateSkill = vi.fn();

    const result = await learningCommand.execute(['promote', 'lc_card_1'], commandContext(db, { installSkill, updateSkill }));

    expect(result.content).toContain('已沉淀任务记忆卡');
    expect(installSkill).not.toHaveBeenCalled();
    expect(updateSkill).not.toHaveBeenCalled();
    expect(candidateRepo.findById('lc_card_1')?.status).toBe('promoted');
    const card = new TaskMemoryCardRepo(db).findByTaskId('task_e5_1');
    expect(card).toMatchObject({
      taskId: 'task_e5_1',
      title: '任务记忆卡：E5 learning assets',
      sourceCandidateId: 'lc_card_1',
      outcome: 'success',
    });
    expect(card?.verificationCommands.join('\n')).toContain('npm run lint');
  });

  it('shows learning cards and skill effect summaries for review', async () => {
    const db = createTestDb();
    new TaskMemoryCardRepo(db).insert({
      id: 'tmc_existing',
      taskId: 'task_existing',
      title: '已有任务记忆卡',
      goal: '验证 cards 命令',
      summary: '用于展示 learning cards。',
      keyDecisions: [],
      changedFiles: [],
      verificationCommands: ['npm test'],
      pitfalls: [],
      artifacts: [],
      outcome: 'success',
      sourceCandidateId: 'lc_existing',
      createdAt: '2026-04-27T03:10:00Z',
      updatedAt: '2026-04-27T03:10:00Z',
    });
    new SkillEffectSummaryRepo(db).recordUsage({
      executorName: 'mock-executor',
      skillName: 'test-driven-development',
      skillVersion: '1.1.0',
      eventType: 'skill_completed',
      helpful: true,
      patchCandidateCreated: false,
      failureReason: null,
      usedAt: '2026-04-27T03:11:00Z',
    });

    const cards = await learningCommand.execute(['cards'], commandContext(db));
    const skills = await learningCommand.execute(['skills'], commandContext(db));
    const summary = await learningCommand.execute(['summary'], commandContext(db));

    expect(cards.content).toContain('已有任务记忆卡');
    expect(skills.content).toContain('test-driven-development@1.1.0');
    expect(skills.content).toContain('成功率 100%');
    expect(summary.content).toContain('任务记忆卡 1');
    expect(summary.content).toContain('Skill Summary 1');
  });
});
