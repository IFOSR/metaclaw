import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryEngine } from '../../src/core/memory-engine.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('MemoryEngine', () => {
  let engine: MemoryEngine;

  beforeEach(() => {
    const db = createTestDb();
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    engine = new MemoryEngine(prefRepo, obsRepo);
  });

  it('should observe patterns and track count', () => {
    const r1 = engine.observe('使用正式语气', 'task_1');
    expect(r1.observation.occurrenceCount).toBe(1);
    expect(r1.shouldPromptConfirm).toBe(false);

    const r2 = engine.observe('使用正式语气', 'task_2');
    expect(r2.observation.occurrenceCount).toBe(2);
    expect(r2.shouldPromptConfirm).toBe(false);

    const r3 = engine.observe('使用正式语气', 'task_3');
    expect(r3.observation.occurrenceCount).toBe(3);
    expect(r3.shouldPromptConfirm).toBe(true);
  });

  it('should confirm observation as preference', () => {
    engine.observe('使用正式语气', 'task_1');
    engine.observe('使用正式语气', 'task_2');
    const r3 = engine.observe('使用正式语气', 'task_3');

    const pref = engine.confirm(r3.observation.id, 'global');
    expect(pref.status).toBe('confirmed');
    expect(pref.content).toBe('使用正式语气');
    expect(pref.confidence).toBe(0.9);
  });

  it('should reject observation', () => {
    engine.observe('临时指令', 'task_1');
    engine.observe('临时指令', 'task_2');
    const r3 = engine.observe('临时指令', 'task_3');

    engine.reject(r3.observation.id);
    const candidates = engine.getCandidates();
    expect(candidates).toHaveLength(0);
  });

  it('should add manual preference', () => {
    const pref = engine.addManual({
      content: '张总偏好正式语气',
      scope: 'contact',
      type: 'contact',
      subject: '张总',
    });
    expect(pref.status).toBe('confirmed');
    expect(pref.confidence).toBe(1.0);
  });

  it('should recall preferences by subject', () => {
    engine.addManual({
      content: '使用正式敬语',
      scope: 'contact',
      type: 'contact',
      subject: '张总',
    });

    const results = engine.recall({ keywords: [], subject: '张总' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('使用正式敬语');
  });

  it('should recall preferences by keyword', () => {
    engine.addManual({
      content: '输出用 Markdown 格式',
      scope: 'global',
      type: 'style',
    });

    const results = engine.recall({ keywords: ['Markdown'] });
    expect(results).toHaveLength(1);
  });

  it('should respect scope priority in recall', () => {
    engine.addManual({
      content: '全局偏好',
      scope: 'global',
      type: 'style',
    });
    engine.addManual({
      content: '联系人偏好',
      scope: 'contact',
      type: 'contact',
      subject: '张总',
    });

    const results = engine.recall({ keywords: ['偏好'], subject: '张总' });
    // contact 优先级高于 global
    expect(results[0].scope).toBe('contact');
  });

  it('should recall task-local preferences directly for the current task', () => {
    engine.addManual({
      content: '当前任务固定保留风险栏目',
      scope: 'task-local',
      type: 'style',
      subject: 'task_demo_1',
    });
    engine.addManual({
      content: '输出尽量简洁',
      scope: 'global',
      type: 'style',
    });

    const results = engine.recall({
      taskId: 'task_demo_1',
      keywords: [],
      userInput: '继续刚才那个任务',
    });

    expect(results[0].scope).toBe('task-local');
    expect(results[0].subject).toBe('task_demo_1');
    expect(results[1].scope).toBe('global');
  });

  it('includes confirmed global preferences as low-priority defaults', () => {
    engine.addManual({
      content: '输出尽量简洁',
      scope: 'global',
      type: 'style',
    });

    const results = engine.recall({
      keywords: [],
      userInput: '整理 Phoenix 项目周报',
    });

    expect(results).toHaveLength(1);
    expect(results[0].scope).toBe('global');
    expect(results[0].content).toBe('输出尽量简洁');
  });

  it('does not apply personality-tone global preferences to structured deliverable scenes like PPT', () => {
    engine.addManual({
      content: '用活泼的语气',
      scope: 'global',
      type: 'style',
    });

    const results = engine.recall({
      keywords: ['整理成ppt'],
      userInput: '直接把刚才我们讨论的内容整理成ppt',
    });

    expect(results).toHaveLength(0);
  });

  it('still applies general global expression preferences in structured tasks when they are not personality-tone cues', () => {
    engine.addManual({
      content: '输出尽量简洁',
      scope: 'global',
      type: 'style',
    });
    engine.addManual({
      content: '用活泼的语气',
      scope: 'global',
      type: 'style',
    });

    const results = engine.recall({
      keywords: ['项目', '周报'],
      userInput: '整理 Phoenix 项目周报，输出尽量简洁',
    });

    expect(results.map(result => result.content)).toContain('输出尽量简洁');
    expect(results.map(result => result.content)).not.toContain('用活泼的语气');
  });

  it('builds review candidates and delegates semantic merge to hybrid recaller', async () => {
    const db = createTestDb();
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    prefRepo.insert({
      id: 'pref_project',
      type: 'domain',
      scope: 'project',
      subject: 'Phoenix',
      content: 'Phoenix 周报统一保留风险栏目',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 2,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-04-20T00:00:00Z',
      createdAt: '2026-04-20T00:00:00Z',
      updatedAt: '2026-04-20T00:00:00Z',
    });
    const hybridRecaller = {
      recall: vi.fn().mockResolvedValue({
        preferenceCandidates: [{
          id: 'pref_project',
          preferenceId: 'pref_project',
          scope: 'project',
          subject: 'Phoenix',
          summary: 'Phoenix 周报统一保留风险栏目',
          reason: '命中主体：Phoenix',
          source: 'rule',
          score: 100,
        }],
        taskCandidates: [],
        auditId: 'recall_1',
      }),
    };
    const reviewEngine = new MemoryEngine(prefRepo, obsRepo, undefined, hybridRecaller as any);

    const result = await reviewEngine.recallForReview({
      keywords: ['Phoenix', '周报'],
      subject: 'Phoenix',
      userInput: '继续整理 Phoenix 周报',
    });

    expect(hybridRecaller.recall).toHaveBeenCalledTimes(1);
    expect(hybridRecaller.recall).toHaveBeenCalledWith(expect.objectContaining({
      queryText: '继续整理 Phoenix 周报',
      rulePreferenceCandidates: [
        expect.objectContaining({
          id: 'pref_project',
          source: 'rule',
        }),
      ],
    }));
    expect(result.auditId).toBe('recall_1');
  });
});
