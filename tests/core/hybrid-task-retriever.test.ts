import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskSearchIndexRepo } from '../../src/storage/task-search-index-repo.js';
import { TaskRelationRepo } from '../../src/storage/task-relation-repo.js';
import { TaskMemoryEmbeddingRepo } from '../../src/storage/task-memory-embedding-repo.js';
import { RecallFeedbackRepo } from '../../src/storage/recall-feedback-repo.js';
import { HybridTaskRetriever } from '../../src/core/hybrid-task-retriever.js';
import { HybridMemoryRecaller } from '../../src/core/hybrid-memory-recaller.js';

function createHarness() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const taskSearchIndexRepo = new TaskSearchIndexRepo(db);
  const taskRepo = new TaskRepo(db, taskSearchIndexRepo);
  const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-hybrid-task-retriever-test-snapshots');
  const taskRelationRepo = new TaskRelationRepo(db);
  const taskMemoryEmbeddingRepo = new TaskMemoryEmbeddingRepo(db);
  const recallFeedbackRepo = new RecallFeedbackRepo(db);
  return {
    db,
    taskRepo,
    taskEngine,
    taskSearchIndexRepo,
    taskRelationRepo,
    taskMemoryEmbeddingRepo,
    recallFeedbackRepo,
  };
}

describe('HybridTaskRetriever', () => {
  it('prioritizes explicit task id and focus task before lexical history', async () => {
    const { taskRepo, taskEngine, taskSearchIndexRepo } = createHarness();
    const explicitTask = taskEngine.create({
      title: 'Explicit Phoenix 周报恢复',
      goal: '恢复明确指定的 Phoenix 周报任务',
    });
    const focusTask = taskEngine.create({
      title: 'Focus Phoenix 材料整理',
      goal: '当前焦点任务',
    });
    taskEngine.create({
      title: 'Phoenix 历史复盘',
      goal: '历史任务，不应超过 explicit/focus',
    });
    const retriever = new HybridTaskRetriever({ taskRepo, taskSearchIndexRepo });

    const result = await retriever.retrieve({
      queryText: 'Phoenix 周报',
      explicitTaskId: explicitTask.id,
      focusTaskId: focusTask.id,
      topK: 3,
    });

    expect(result[0]?.taskId).toBe(explicitTask.id);
    expect(result[0]?.sources.map(source => source.kind)).toContain('explicit');
    expect(result[1]?.taskId).toBe(focusTask.id);
    expect(result[1]?.sources.map(source => source.kind)).toContain('focus');
  });

  it('recalls FTS matches with provenance and expands related tasks', async () => {
    const { taskRepo, taskEngine, taskSearchIndexRepo, taskRelationRepo } = createHarness();
    const sourceTask = taskEngine.create({
      title: 'Atlas FTS 索引方案',
      goal: '设计 task_search_index 检索层',
    });
    const relatedTask = taskEngine.create({
      title: 'Atlas Hybrid Retriever',
      goal: '基于索引候选做统一召回',
    });
    taskRelationRepo.insert({
      id: 'rel_atlas_index_retriever',
      sourceTaskId: sourceTask.id,
      targetTaskId: relatedTask.id,
      relationType: 'follow_up',
      createdAt: '2026-06-14T10:00:00.000Z',
    });
    const retriever = new HybridTaskRetriever({ taskRepo, taskSearchIndexRepo, taskRelationRepo });

    const result = await retriever.retrieve({
      queryText: 'task_search_index',
      topK: 5,
    });

    const source = result.find(candidate => candidate.taskId === sourceTask.id);
    const related = result.find(candidate => candidate.taskId === relatedTask.id);
    expect(source?.sources.some(item => item.kind === 'fts')).toBe(true);
    expect(related?.sources.some(item => item.kind === 'relation')).toBe(true);
    expect(source?.reason).toContain('来源');
  });

  it('limits semantic rerank to indexed candidate task ids', async () => {
    const {
      taskRepo,
      taskEngine,
      taskSearchIndexRepo,
      taskMemoryEmbeddingRepo,
    } = createHarness();
    const indexedTask = taskEngine.create({
      title: 'Phoenix 周报索引候选',
      goal: '整理 Phoenix 周报',
    });
    const nonCandidateTask = taskEngine.create({
      title: 'Unrelated Budget Email',
      goal: '写预算邮件',
    });
    taskMemoryEmbeddingRepo.upsert({
      id: 'emb_indexed',
      taskId: indexedTask.id,
      memoryKind: 'task_summary',
      sourceId: indexedTask.id,
      provider: 'test',
      model: 'test',
      dimension: 2,
      vector: [1, 0],
      contentHash: 'hash_indexed',
      createdAt: '2026-06-14T10:00:00.000Z',
      updatedAt: '2026-06-14T10:00:00.000Z',
    });
    taskMemoryEmbeddingRepo.upsert({
      id: 'emb_non_candidate',
      taskId: nonCandidateTask.id,
      memoryKind: 'task_summary',
      sourceId: nonCandidateTask.id,
      provider: 'test',
      model: 'test',
      dimension: 2,
      vector: [1, 0],
      contentHash: 'hash_non_candidate',
      createdAt: '2026-06-14T10:00:00.000Z',
      updatedAt: '2026-06-14T10:00:00.000Z',
    });
    const findByTaskIds = vi.spyOn(taskMemoryEmbeddingRepo, 'findByTaskIds');
    const retriever = new HybridTaskRetriever({
      taskRepo,
      taskSearchIndexRepo,
      taskMemoryEmbeddingRepo,
      embeddingProvider: {
        provider: 'test',
        model: 'test',
        embed: vi.fn().mockResolvedValue([[1, 0]]),
      },
    });

    const result = await retriever.retrieve({
      queryText: 'Phoenix 周报',
      topK: 5,
    });

    expect(findByTaskIds).toHaveBeenCalled();
    expect(findByTaskIds.mock.calls[0]?.[0]).toContain(indexedTask.id);
    expect(findByTaskIds.mock.calls[0]?.[0]).not.toContain(nonCandidateTask.id);
    expect(result.find(candidate => candidate.taskId === indexedTask.id)?.sources.map(source => source.kind)).toContain('semantic');
    expect(result.find(candidate => candidate.taskId === nonCandidateTask.id)?.sources.map(source => source.kind)).not.toContain('semantic');
  });

  it('applies recall feedback by hiding or downranking candidates', async () => {
    const { taskRepo, taskEngine, taskSearchIndexRepo, recallFeedbackRepo } = createHarness();
    const hiddenTask = taskEngine.create({
      title: 'Phoenix 隐藏任务',
      goal: 'Phoenix 不应被召回',
    });
    const visibleTask = taskEngine.create({
      title: 'Phoenix 可见任务',
      goal: 'Phoenix 应继续召回',
    });
    recallFeedbackRepo.insert({
      id: 'fb_hide_phoenix',
      targetKind: 'task',
      targetId: hiddenTask.id,
      action: 'hide',
      createdAt: '2026-06-14T10:00:00.000Z',
    });
    recallFeedbackRepo.insert({
      id: 'fb_irrelevant_phoenix',
      targetKind: 'task',
      targetId: visibleTask.id,
      action: 'irrelevant',
      createdAt: '2026-06-14T10:01:00.000Z',
    });
    const retriever = new HybridTaskRetriever({
      taskRepo,
      taskSearchIndexRepo,
      recallFeedbackRepo,
    });

    const result = await retriever.retrieve({
      queryText: 'Phoenix',
      topK: 5,
    });

    expect(result.map(candidate => candidate.taskId)).not.toContain(hiddenTask.id);
    expect(result.find(candidate => candidate.taskId === visibleTask.id)?.reason).toContain('不相关');
  });

  it('feeds indexed task retrieval into HybridMemoryRecaller when configured', async () => {
    const { taskRepo, taskEngine, taskSearchIndexRepo } = createHarness();
    const task = taskEngine.create({
      title: 'Orion Task OS 方案',
      goal: '整理 Orion Task OS 架构方案',
    });
    const retriever = new HybridTaskRetriever({ taskRepo, taskSearchIndexRepo });
    const recaller = new HybridMemoryRecaller({
      hybridTaskRetriever: retriever,
    });

    const result = await recaller.recall({
      queryText: 'Orion Task OS',
      keywords: ['Orion'],
      rulePreferenceCandidates: [],
      ruleTaskCandidates: [],
      topK: 5,
    });

    expect(result.taskCandidates[0]).toMatchObject({
      taskId: task.id,
      sourceTaskId: task.id,
      memoryKind: 'task_summary',
    });
    expect(result.taskCandidates[0]?.reason).toContain('统一任务召回');
  });

  it('does not recall the current task as historical memory unless explicitly requested', async () => {
    const { taskRepo, taskEngine, taskSearchIndexRepo } = createHarness();
    const currentTask = taskEngine.create({
      title: 'Current Smoke Task',
      goal: 'create smoke-result.md',
    });
    const historyTask = taskEngine.create({
      title: 'Historical Smoke Task',
      goal: 'previous smoke-result.md task',
    });
    const retriever = new HybridTaskRetriever({ taskRepo, taskSearchIndexRepo });

    const implicitResult = await retriever.retrieve({
      queryText: 'smoke-result.md',
      currentTaskId: currentTask.id,
      topK: 5,
    });

    expect(implicitResult.map(candidate => candidate.taskId)).not.toContain(currentTask.id);
    expect(implicitResult.map(candidate => candidate.taskId)).toContain(historyTask.id);

    const explicitResult = await retriever.retrieve({
      queryText: 'smoke-result.md',
      currentTaskId: currentTask.id,
      explicitTaskId: currentTask.id,
      topK: 5,
    });

    expect(explicitResult[0]?.taskId).toBe(currentTask.id);
    expect(explicitResult[0]?.sources.map(source => source.kind)).toContain('explicit');
  });
});
