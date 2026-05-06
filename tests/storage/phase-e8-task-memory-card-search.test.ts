import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskMemoryCardRepo } from '../../src/storage/task-memory-card-repo.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertPhoenixCards(repo: TaskMemoryCardRepo) {
  repo.insert({
    id: 'tmc_resume_phoenix_weekly',
    taskId: 'task_phoenix_weekly_parked',
    title: 'Phoenix 周报整理恢复',
    goal: '继续整理 Phoenix 周报并补齐经营数据',
    summary: '已完成风险栏目，剩余经营数据栏目需要补齐后输出周报。',
    keyDecisions: ['沿用风险栏目和经营数据栏目结构'],
    changedFiles: ['docs/phoenix-weekly.md'],
    verificationCommands: ['npm test -- tests/phoenix-weekly.test.ts'],
    pitfalls: ['恢复任务时不要覆盖已完成的风险栏目'],
    artifacts: ['docs/phoenix-weekly-draft.md'],
    outcome: 'partial',
    sourceCandidateId: 'lc_resume_phoenix_weekly',
    createdAt: '2026-04-20T00:00:00Z',
    updatedAt: '2026-04-20T00:00:00Z',
  });

  repo.insert({
    id: 'tmc_reference_phoenix_review',
    taskId: 'task_phoenix_review_done',
    title: 'Phoenix 复盘报告',
    goal: '输出 Phoenix 项目复盘报告',
    summary: '已沉淀风险、经营数据和结论三段式结构，可作为类似材料参考。',
    keyDecisions: ['报告固定包含风险、经营数据、结论'],
    changedFiles: ['docs/phoenix-review.md'],
    verificationCommands: ['npm test -- tests/phoenix-review.test.ts'],
    pitfalls: ['不要把复盘结论直接当作本周事实'],
    artifacts: ['docs/phoenix-review-output.md'],
    outcome: 'success',
    sourceCandidateId: 'lc_reference_phoenix_review',
    createdAt: '2026-04-19T00:00:00Z',
    updatedAt: '2026-04-19T00:00:00Z',
  });

  repo.insert({
    id: 'tmc_unrelated_email',
    taskId: 'task_budget_email',
    title: '预算确认邮件',
    goal: '给张总写预算确认邮件',
    summary: '使用正式语气提醒张总确认预算。',
    keyDecisions: ['邮件保持正式语气'],
    changedFiles: ['drafts/budget-email.md'],
    verificationCommands: [],
    pitfalls: ['不要使用周报结构'],
    artifacts: ['drafts/budget-email.md'],
    outcome: 'success',
    sourceCandidateId: 'lc_budget_email',
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
  });
}

describe('Phase E8 TaskMemoryCard recall search', () => {
  it('returns only highly relevant task memory cards and classifies resume versus reference recall', () => {
    const db = createTestDb();
    const repo = new TaskMemoryCardRepo(db);
    insertPhoenixCards(repo);

    const result = repo.searchRelevant({
      queryText: '继续整理 Phoenix 周报，补齐经营数据栏目',
      currentTaskId: 'task_phoenix_weekly_parked',
      keywords: ['Phoenix', '周报', '经营数据'],
      topK: 5,
    });

    expect(result.map(candidate => candidate.taskId)).toEqual([
      'task_phoenix_weekly_parked',
      'task_phoenix_review_done',
    ]);
    expect(result[0]).toMatchObject({
      taskId: 'task_phoenix_weekly_parked',
      recallMode: 'resume',
      outcome: 'partial',
    });
    expect(result[0].reason).toContain('恢复型召回');
    expect(result[1]).toMatchObject({
      taskId: 'task_phoenix_review_done',
      recallMode: 'reference',
      outcome: 'success',
    });
    expect(result[1].reason).toContain('参考型召回');
    expect(result.every(candidate => candidate.score >= 60)).toBe(true);
  });

  it('keeps weakly related task memory cards out of recall results', () => {
    const db = createTestDb();
    const repo = new TaskMemoryCardRepo(db);
    insertPhoenixCards(repo);

    const result = repo.searchRelevant({
      queryText: '帮我写一封预算确认邮件，正式提醒张总',
      currentTaskId: 'task_new_email',
      keywords: ['预算', '邮件', '张总'],
      topK: 5,
    });

    expect(result.map(candidate => candidate.taskId)).toEqual(['task_budget_email']);
    expect(result.map(candidate => candidate.taskId)).not.toContain('task_phoenix_weekly_parked');
    expect(result.map(candidate => candidate.taskId)).not.toContain('task_phoenix_review_done');
  });

  it('prioritizes explicit entity matches over generic research terms', () => {
    const db = createTestDb();
    const repo = new TaskMemoryCardRepo(db);

    repo.insert({
      id: 'tmc_palantir_financials',
      taskId: 'task_palantir_analysis',
      title: 'Palantir 财报与商业模式变化深度调研',
      goal: '分析 Palantir 最新财报后的商业模式变化、前景和转型路径',
      summary: '围绕 Palantir AIP、政府业务、商业客户增长和利润率变化形成深度分析。',
      keyDecisions: ['重点区分政府业务和商业业务增长逻辑'],
      changedFiles: ['docs/palantir-analysis.md'],
      verificationCommands: [],
      pitfalls: ['不要把历史估值结论当作最新财报事实'],
      artifacts: ['docs/palantir-analysis.md'],
      outcome: 'success',
      sourceCandidateId: 'lc_palantir',
      createdAt: '2026-05-06T00:00:00Z',
      updatedAt: '2026-05-06T00:00:00Z',
    });

    repo.insert({
      id: 'tmc_yixunpan_geo',
      taskId: 'task_yixunpan_geo',
      title: '易寻盘与海外 GEO 公司调研',
      goal: '调研易寻盘以及中国做海外 GEO 的公司、产品和竞争力',
      summary: '输出易寻盘公司情况、海外 GEO 产品对比和竞争力判断。',
      keyDecisions: ['按公司、产品、竞争力三个维度组织'],
      changedFiles: ['docs/yixunpan-geo.md'],
      verificationCommands: [],
      pitfalls: ['不要把 GEO 调研泛化成所有 AI 公司调研'],
      artifacts: ['docs/yixunpan-geo.md'],
      outcome: 'success',
      sourceCandidateId: 'lc_yixunpan',
      createdAt: '2026-05-06T01:00:00Z',
      updatedAt: '2026-05-06T01:00:00Z',
    });

    const result = repo.searchRelevant({
      queryText: '今天早上我是不是让你做过 Palantir 分析相关任务',
      currentTaskId: 'task_current_recall',
      keywords: ['今天', '早上', 'Palantir', '分析', '相关', '任务'],
      topK: 5,
    });

    expect(result.map(candidate => candidate.taskId)).toEqual(['task_palantir_analysis']);
    expect(result[0]?.score).toBeGreaterThanOrEqual(60);
    expect(result[0]?.title).toContain('Palantir');
  });
});
