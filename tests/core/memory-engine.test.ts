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
    expect(results).toHaveLength(1);
  });

  it('does not include confirmed global preferences as unrelated low-priority defaults', () => {
    engine.addManual({
      content: '输出尽量简洁',
      scope: 'global',
      type: 'style',
    });

    const results = engine.recall({
      keywords: [],
      userInput: '整理 Phoenix 项目周报',
    });

    expect(results).toHaveLength(0);
  });

  it('does not recall a Feishu document workflow preference for unrelated image analysis input', () => {
    engine.addManual({
      content: '凡是让你生成相关报告的详细内容展示的，都要同步生成飞书云文档，并生成在线预览',
      scope: 'global',
      type: 'domain',
    });

    const results = engine.recall({
      keywords: ['图片', '分析', '内容'],
      userInput: '这不就是我给你说的图片吗',
    });

    expect(results).toHaveLength(0);
  });

  it('uses executor semantic preference recall for review and does not keyword fallback when executor returns empty', async () => {
    const db = createTestDb();
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    prefRepo.insert({
      id: 'pref_feishu_report',
      type: 'domain',
      scope: 'global',
      subject: null,
      content: '凡是让你生成相关报告的详细内容展示的，都要同步生成飞书云文档，并生成在线预览',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 1,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-05-14T00:00:00Z',
      createdAt: '2026-05-14T00:00:00Z',
      updatedAt: '2026-05-14T00:00:00Z',
    });
    const preferenceJudge = {
      recallPreferences: vi.fn().mockResolvedValue([]),
    };
    const reviewEngine = new MemoryEngine(prefRepo, obsRepo, undefined, undefined, undefined, preferenceJudge);

    const result = await reviewEngine.recallForReview({
      keywords: ['相关', '报告', '内容'],
      userInput: '这不就是我给你说的图片吗',
    });

    expect(preferenceJudge.recallPreferences).toHaveBeenCalledTimes(1);
    expect(result.preferenceCandidates).toHaveLength(0);
  });

  it('falls back to legacy preference recall only when executor semantic recall fails', async () => {
    const db = createTestDb();
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    prefRepo.insert({
      id: 'pref_markdown',
      type: 'style',
      scope: 'global',
      subject: null,
      content: '输出用 Markdown 格式',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 1,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-05-14T00:00:00Z',
      createdAt: '2026-05-14T00:00:00Z',
      updatedAt: '2026-05-14T00:00:00Z',
    });
    const preferenceJudge = {
      recallPreferences: vi.fn().mockRejectedValue(new Error('executor unavailable')),
    };
    const reviewEngine = new MemoryEngine(prefRepo, obsRepo, undefined, undefined, undefined, preferenceJudge);

    const result = await reviewEngine.recallForReview({
      keywords: ['Markdown'],
      userInput: '请用 Markdown 输出',
    });

    expect(preferenceJudge.recallPreferences).toHaveBeenCalledTimes(1);
    expect(result.preferenceCandidates.map(candidate => candidate.preferenceId)).toEqual(['pref_markdown']);
    expect(result.preferenceCandidates[0]?.reason).toBe('命中通用表达偏好');
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

  it('does not apply playful personality-tone preferences to formal research deliverables', () => {
    engine.addManual({
      content: '用活泼欢快的语气',
      scope: 'global',
      type: 'style',
    });
    engine.addManual({
      content: '使用正式严谨的表达',
      scope: 'global',
      type: 'style',
    });

    const results = engine.recall({
      keywords: ['正式', '调研', '报告'],
      userInput: '帮我写一份正式的行业调研报告',
    });

    expect(results.map(result => result.content)).not.toContain('用活泼欢快的语气');
    expect(results.map(result => result.content)).toContain('使用正式严谨的表达');
  });

  it('still applies playful personality-tone preferences when the user explicitly asks for playful creative copy', () => {
    engine.addManual({
      content: '用活泼欢快的语气',
      scope: 'global',
      type: 'style',
    });

    const results = engine.recall({
      keywords: ['活泼', '小红书', '文案'],
      userInput: '帮我写一条活泼欢快的小红书文案',
    });

    expect(results.map(result => result.content)).toContain('用活泼欢快的语气');
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

  it('annotates LLM preference recall decisions with tri-state applicability actions', async () => {
    const db = createTestDb();
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    prefRepo.insert({
      id: 'pref_auto',
      type: 'style',
      scope: 'project',
      subject: 'MetaClaw',
      content: 'MetaClaw 优化方案默认先给结论，再列执行细节',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 1,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-05-20T00:00:00Z',
      createdAt: '2026-05-20T00:00:00Z',
      updatedAt: '2026-05-20T00:00:00Z',
    });
    prefRepo.insert({
      id: 'pref_review',
      type: 'domain',
      scope: 'global',
      subject: null,
      content: '长篇报告需要同步生成飞书云文档',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 1,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-05-20T00:00:00Z',
      createdAt: '2026-05-20T00:00:00Z',
      updatedAt: '2026-05-20T00:00:00Z',
    });
    prefRepo.insert({
      id: 'pref_suppress',
      type: 'style',
      scope: 'global',
      subject: null,
      content: '小红书文案使用活泼语气',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 1,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-05-20T00:00:00Z',
      createdAt: '2026-05-20T00:00:00Z',
      updatedAt: '2026-05-20T00:00:00Z',
    });
    const preferenceJudge = {
      recallPreferences: vi.fn().mockResolvedValue([
        {
          preferenceId: 'pref_auto',
          action: 'auto_apply',
          reason: '当前请求是 MetaClaw 优化方案，输出结构偏好直接适用',
          score: 0.91,
        },
        {
          preferenceId: 'pref_review',
          action: 'ask_review',
          reason: '可能改变交付路径，需要确认是否外部同步',
          score: 0.7,
        },
        {
          preferenceId: 'pref_suppress',
          action: 'suppress',
          reason: '当前不是创意文案场景',
          score: 0.18,
        },
      ]),
    };
    const reviewEngine = new MemoryEngine(prefRepo, obsRepo, undefined, undefined, undefined, preferenceJudge);

    const result = await reviewEngine.recallForReview({
      keywords: ['MetaClaw', '优化', '方案'],
      subject: 'MetaClaw',
      userInput: '根据最终优化方案实施 MetaClaw',
    });

    expect(result.preferenceCandidates.map(candidate => candidate.preferenceId)).toEqual([
      'pref_auto',
      'pref_review',
    ]);
    expect(result.preferenceCandidates[0]).toEqual(expect.objectContaining({
      preferenceId: 'pref_auto',
      applicabilityAction: 'auto_apply',
      applicabilityScore: 0.91,
      applicabilityReason: '当前请求是 MetaClaw 优化方案，输出结构偏好直接适用',
      judgeSource: 'llm',
    }));
    expect(result.preferenceCandidates[1]).toEqual(expect.objectContaining({
      preferenceId: 'pref_review',
      applicabilityAction: 'ask_review',
      applicabilityScore: 0.7,
      judgeSource: 'llm',
    }));
  });

  it('auto-applies explicit subject matches when LLM judge is unavailable', async () => {
    const db = createTestDb();
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    prefRepo.insert({
      id: 'pref_contact_low_confidence',
      type: 'contact',
      scope: 'contact',
      subject: '张总',
      content: '给张总的邮件使用正式语气',
      status: 'confirmed',
      confidence: 0.7,
      occurrenceCount: 1,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-05-20T00:00:00Z',
      createdAt: '2026-05-20T00:00:00Z',
      updatedAt: '2026-05-20T00:00:00Z',
    });
    const preferenceJudge = {
      recallPreferences: vi.fn().mockRejectedValue(new Error('executor unavailable')),
    };
    const reviewEngine = new MemoryEngine(prefRepo, obsRepo, undefined, undefined, undefined, preferenceJudge);

    const result = await reviewEngine.recallForReview({
      keywords: ['张总', '邮件'],
      subject: '张总',
      userInput: '给张总起草一封邮件',
    });

    expect(result.preferenceCandidates[0]).toEqual(expect.objectContaining({
      preferenceId: 'pref_contact_low_confidence',
      applicabilityAction: 'auto_apply',
      applicabilityScore: 0.82,
      judgeSource: 'fallback',
    }));
  });
});
