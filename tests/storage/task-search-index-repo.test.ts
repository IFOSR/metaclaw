import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskMemoryCardRepo } from '../../src/storage/task-memory-card-repo.js';
import { TaskSearchIndexRepo } from '../../src/storage/task-search-index-repo.js';

function createHarness() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const taskSearchIndexRepo = new TaskSearchIndexRepo(db);
  const taskRepo = new TaskRepo(db, taskSearchIndexRepo);
  const taskMemoryCardRepo = new TaskMemoryCardRepo(db, taskSearchIndexRepo);
  const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-task-search-index-test-snapshots');
  return { db, taskSearchIndexRepo, taskMemoryCardRepo, taskEngine };
}

describe('TaskSearchIndexRepo', () => {
  it('indexes task title and goal synchronously when a task is created', () => {
    const { taskEngine, taskSearchIndexRepo } = createHarness();
    const task = taskEngine.create({
      title: 'Phoenix 周报整理',
      goal: '补齐经营数据栏目并输出周报',
    });

    const results = taskSearchIndexRepo.search('经营数据');

    expect(results.map(result => result.taskId)).toContain(task.id);
    expect(results[0]).toMatchObject({
      taskId: task.id,
      sourceKind: 'task',
    });
  });

  it('indexes snapshots and artifacts when a task is updated', () => {
    const { taskEngine, taskSearchIndexRepo } = createHarness();
    const task = taskEngine.create({
      title: 'Phoenix 周报整理',
      goal: '整理 Phoenix 周报',
    });

    taskEngine['taskRepo'].appendSnapshot(task.id, {
      done: ['已完成风险栏目'],
      pending: ['补齐经营数据栏目'],
      nextStep: '输出 docs/phoenix-weekly-draft.md',
      pauseReason: '等待经营数据',
      createdAt: '2026-06-14T08:00:00.000Z',
    });
    taskEngine['taskRepo'].update(task.id, {
      artifacts: ['docs/phoenix-weekly-draft.md'],
    });

    expect(taskSearchIndexRepo.search('风险栏目').some(result => result.sourceKind === 'snapshot')).toBe(true);
    expect(taskSearchIndexRepo.search('phoenix-weekly-draft').some(result => result.sourceKind === 'artifact')).toBe(true);
  });

  it('indexes task memory cards with decisions, changed files, verification commands, pitfalls, and artifacts', () => {
    const { taskMemoryCardRepo, taskSearchIndexRepo } = createHarness();

    taskMemoryCardRepo.insert({
      id: 'tmc_phoenix_weekly',
      taskId: 'task_phoenix_weekly',
      title: 'Phoenix 周报记忆卡',
      goal: '沉淀 Phoenix 周报执行经验',
      summary: '周报结构包含风险、经营数据、结论。',
      keyDecisions: ['固定三段式结构'],
      changedFiles: ['docs/phoenix-weekly.md'],
      verificationCommands: ['npm test -- tests/phoenix-weekly.test.ts'],
      pitfalls: ['不要覆盖已确认风险栏目'],
      artifacts: ['docs/phoenix-weekly-output.md'],
      outcome: 'success',
      sourceCandidateId: null,
      createdAt: '2026-06-14T08:00:00.000Z',
      updatedAt: '2026-06-14T08:00:00.000Z',
    });

    const results = taskSearchIndexRepo.search('phoenix-weekly-output');

    expect(results[0]).toMatchObject({
      taskId: 'task_phoenix_weekly',
      sourceKind: 'memory_card',
    });
    expect(results[0]?.snippet).toContain('phoenix-weekly-output');
  });

  it('indexes task interactions through the SQLite trigger', () => {
    const { db, taskEngine, taskSearchIndexRepo } = createHarness();
    const task = taskEngine.create({
      title: '索引交互测试',
      goal: '验证 interaction trigger',
    });

    db.prepare(`
      INSERT INTO interactions (id, task_id, session_id, user_input, system_output, executor_used, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'int_search_index_1',
      task.id,
      'sess_search_index',
      '请继续整理 Ranger 数据源说明',
      '已补充 Ranger 数据源字段解释',
      'codex-cli',
      '2026-06-14T08:00:00.000Z',
    );

    const results = taskSearchIndexRepo.search('Ranger 数据源');

    expect(results.some(result => result.sourceKind === 'interaction' && result.sourceId === 'int_search_index_1')).toBe(true);
  });

  it('rebuilds an equivalent searchable index from existing tasks, cards, artifacts, snapshots, and interactions', () => {
    const { db, taskEngine, taskMemoryCardRepo, taskSearchIndexRepo } = createHarness();
    const task = taskEngine.create({
      title: 'Atlas 架构方案',
      goal: '输出 Atlas 架构方案并保存文档',
    });
    taskEngine['taskRepo'].appendSnapshot(task.id, {
      done: ['完成模块边界梳理'],
      pending: ['补充验收清单'],
      nextStep: '保存 docs/atlas-architecture.md',
      pauseReason: '等待评审',
      createdAt: '2026-06-14T09:00:00.000Z',
    });
    taskEngine['taskRepo'].update(task.id, {
      artifacts: ['docs/atlas-architecture.md'],
    });
    taskMemoryCardRepo.insert({
      id: 'tmc_atlas_architecture',
      taskId: task.id,
      title: 'Atlas 架构方案记忆卡',
      goal: '沉淀 Atlas 架构方案经验',
      summary: '采用检索索引优先的任务上下文策略。',
      keyDecisions: ['先建 FTS 索引再做 hybrid retriever'],
      changedFiles: ['docs/atlas-architecture.md'],
      verificationCommands: ['npm test -- tests/storage/task-search-index-repo.test.ts'],
      pitfalls: ['不要全量扫描 embedding'],
      artifacts: ['docs/atlas-architecture.md'],
      outcome: 'success',
      sourceCandidateId: null,
      createdAt: '2026-06-14T09:00:00.000Z',
      updatedAt: '2026-06-14T09:00:00.000Z',
    });
    db.prepare(`
      INSERT INTO interactions (id, task_id, session_id, user_input, system_output, executor_used, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'int_atlas_architecture',
      task.id,
      'sess_atlas',
      '补充 Atlas 验收清单',
      '验收清单已覆盖 smoke test',
      'codex-cli',
      '2026-06-14T09:30:00.000Z',
    );

    const before = {
      task: taskSearchIndexRepo.search('Atlas 架构方案').map(result => result.sourceKind),
      snapshot: taskSearchIndexRepo.search('模块边界').map(result => result.sourceKind),
      card: taskSearchIndexRepo.search('hybrid retriever').map(result => result.sourceKind),
      artifact: taskSearchIndexRepo.search('atlas-architecture').map(result => result.sourceKind),
      interaction: taskSearchIndexRepo.search('smoke test').map(result => result.sourceKind),
    };

    taskSearchIndexRepo.clear();
    expect(taskSearchIndexRepo.count()).toBe(0);

    const rebuiltCount = taskSearchIndexRepo.rebuild();

    expect(rebuiltCount).toBeGreaterThanOrEqual(5);
    expect(taskSearchIndexRepo.search('Atlas 架构方案').map(result => result.sourceKind)).toEqual(before.task);
    expect(taskSearchIndexRepo.search('模块边界').map(result => result.sourceKind)).toEqual(before.snapshot);
    expect(taskSearchIndexRepo.search('hybrid retriever').map(result => result.sourceKind)).toEqual(before.card);
    expect(taskSearchIndexRepo.search('atlas-architecture').map(result => result.sourceKind)).toEqual(before.artifact);
    expect(taskSearchIndexRepo.search('smoke test').map(result => result.sourceKind)).toEqual(before.interaction);
  });
});
