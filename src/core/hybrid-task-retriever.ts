import { TaskRelevanceRanker } from './task-relevance-ranker.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import type { Task, TaskMemoryCandidate } from './types.js';
import type { TaskSearchIndexRepo, TaskSearchResult } from '../storage/task-search-index-repo.js';
import type { TaskRelationRecord } from '../storage/task-relation-repo.js';
import type { TaskMemoryEmbeddingRecord } from '../storage/task-memory-embedding-repo.js';
import type { RecallFeedbackAction, RecallFeedbackRecord } from '../storage/recall-feedback-repo.js';

export type RetrievedTaskSourceKind = 'focus' | 'fts' | 'semantic' | 'relation' | 'recent' | 'explicit';

export interface RetrievedTaskCandidate {
  taskId: string;
  score: number;
  recallMode: 'resume' | 'reference' | 'avoid' | 'related';
  sources: Array<{
    kind: RetrievedTaskSourceKind;
    sourceId: string;
    snippet: string;
  }>;
  artifacts: string[];
  pitfalls: string[];
  reason: string;
}

export interface HybridTaskRetrieverInput {
  queryText: string;
  keywords?: string[];
  currentTaskId?: string | null;
  focusTaskId?: string | null;
  explicitTaskId?: string | null;
  topK?: number;
  ftsLimit?: number;
}

interface TaskRepoLike {
  findById(id: string): Task | null;
  findAll(): Task[];
}

interface TaskSearchIndexRepoLike {
  search(query: string, limit?: number): TaskSearchResult[];
}

interface TaskRelationRepoLike {
  findBySourceTaskId(sourceTaskId: string): TaskRelationRecord[];
  findByTargetTaskId(targetTaskId: string): TaskRelationRecord[];
}

interface TaskMemoryEmbeddingRepoLike {
  findByTaskIds?(taskIds: string[]): TaskMemoryEmbeddingRecord[];
  findAll(): TaskMemoryEmbeddingRecord[];
}

interface RecallFeedbackRepoLike {
  findActiveForCandidates(input: {
    targetKind: 'task';
    targetIds: string[];
    queryTaskId?: string | null;
  }): RecallFeedbackRecord[];
}

export interface HybridTaskRetrieverDeps {
  taskRepo: TaskRepoLike;
  taskSearchIndexRepo: TaskSearchIndexRepo | TaskSearchIndexRepoLike;
  taskRelationRepo?: TaskRelationRepoLike;
  taskMemoryEmbeddingRepo?: TaskMemoryEmbeddingRepoLike;
  embeddingProvider?: EmbeddingProvider;
  recallFeedbackRepo?: RecallFeedbackRepoLike;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_FTS_LIMIT = 100;
const SEMANTIC_SCORE_MULTIPLIER = 100;
const MIN_SEMANTIC_SCORE = 0.55;

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function buildQuery(input: HybridTaskRetrieverInput): string {
  return [
    input.queryText,
    ...(input.keywords ?? []),
  ].filter(Boolean).join(' ').trim();
}

function buildTaskSummary(task: Task): string {
  const latestSnapshot = task.snapshots[task.snapshots.length - 1];
  if (task.summary) {
    return task.summary;
  }
  if (latestSnapshot) {
    return [
      latestSnapshot.done.length > 0 ? `已完成：${latestSnapshot.done.join('；')}` : '',
      latestSnapshot.pending.length > 0 ? `待处理：${latestSnapshot.pending.join('；')}` : '',
      latestSnapshot.nextStep ? `下一步：${latestSnapshot.nextStep}` : '',
    ].filter(Boolean).join('；');
  }
  return task.goal;
}

function detectPitfalls(task: Task): string[] {
  return task.dependencies
    .filter(dep => dep.status === 'waiting')
    .map(dep => dep.description);
}

function sourceWeight(kind: RetrievedTaskSourceKind): number {
  switch (kind) {
    case 'explicit': return 1000;
    case 'focus': return 700;
    case 'fts': return 120;
    case 'semantic': return 100;
    case 'relation': return 60;
    case 'recent': return 25;
  }
}

function getContinuityBonus(task: Task, currentTaskId: string | null | undefined): number {
  if (task.id === currentTaskId) {
    return 140;
  }
  if (task.status === 'parked' || task.status === 'blocked' || task.status === 'running') {
    return 30;
  }
  if (task.status === 'done') {
    return 12;
  }
  return 0;
}

function getRecallMode(task: Task, currentTaskId: string | null | undefined): RetrievedTaskCandidate['recallMode'] {
  if (task.id === currentTaskId || task.status === 'parked' || task.status === 'blocked' || task.status === 'running') {
    return 'resume';
  }
  if (task.status === 'cancelled' || task.status === 'archived') {
    return 'avoid';
  }
  return 'reference';
}

function shouldExcludeTask(taskId: string, input: HybridTaskRetrieverInput, sourceKind: RetrievedTaskSourceKind): boolean {
  if (taskId !== input.currentTaskId) {
    return false;
  }

  return sourceKind !== 'explicit' && sourceKind !== 'focus';
}

export class HybridTaskRetriever {
  constructor(private readonly deps: HybridTaskRetrieverDeps) {}

  async retrieve(input: HybridTaskRetrieverInput): Promise<RetrievedTaskCandidate[]> {
    const query = buildQuery(input);
    const topK = input.topK ?? DEFAULT_TOP_K;
    const candidates = new Map<string, RetrievedTaskCandidate>();

    this.addDirectCandidate(candidates, input.explicitTaskId ?? null, 'explicit', input);
    this.addDirectCandidate(candidates, input.focusTaskId ?? null, 'focus', input);

    const ftsResults = query
      ? this.deps.taskSearchIndexRepo.search(query, input.ftsLimit ?? DEFAULT_FTS_LIMIT)
      : [];
    for (const result of ftsResults) {
      const task = this.deps.taskRepo.findById(result.taskId);
      if (!task) {
        continue;
      }
      if (shouldExcludeTask(task.id, input, 'fts')) {
        continue;
      }
      this.mergeCandidate(candidates, task, {
        kind: 'fts',
        sourceId: result.sourceId,
        snippet: result.snippet || result.title,
        score: Math.max(1, Math.round(result.score * 100)) + sourceWeight('fts'),
      }, input);
    }

    this.expandRelations(candidates, input);
    this.addRecentCandidates(candidates, input);
    await this.semanticRerankCandidates(candidates, input);
    this.applyTaskFeedback(candidates, input);

    const relevanceScores = this.rankByTaskRelevance(Array.from(candidates.values()), input);
    for (const candidate of candidates.values()) {
      const relevance = relevanceScores.get(candidate.taskId);
      if (relevance) {
        candidate.score += Math.round(relevance.finalScore / 10);
        candidate.reason = `${candidate.reason}；TaskRelevanceRanker ${relevance.recommendation} score=${relevance.finalScore}：${relevance.reason}`;
      }
    }

    return Array.from(candidates.values())
      .sort((left, right) => right.score - left.score || left.taskId.localeCompare(right.taskId))
      .slice(0, topK);
  }

  toTaskMemoryCandidates(candidates: RetrievedTaskCandidate[]): TaskMemoryCandidate[] {
    return candidates.map(candidate => {
      const task = this.deps.taskRepo.findById(candidate.taskId);
      return {
        id: `${candidate.taskId}:task_summary`,
        taskId: candidate.taskId,
        sourceTaskId: candidate.taskId,
        memoryKind: 'task_summary',
        title: task?.title ?? candidate.taskId,
        summary: task ? buildTaskSummary(task) : candidate.reason,
        reason: candidate.reason,
        source: candidate.sources.some(source => source.kind === 'semantic') ? 'semantic' : 'continuity',
        score: candidate.score,
        artifactPaths: candidate.artifacts,
      };
    });
  }

  private addDirectCandidate(
    candidates: Map<string, RetrievedTaskCandidate>,
    taskId: string | null,
    kind: 'explicit' | 'focus',
    input: HybridTaskRetrieverInput,
  ): void {
    if (!taskId) {
      return;
    }

    const task = this.deps.taskRepo.findById(taskId);
    if (!task) {
      return;
    }

    this.mergeCandidate(candidates, task, {
      kind,
      sourceId: task.id,
      snippet: kind === 'explicit' ? `显式任务 ID：${task.id}` : `当前焦点任务：${task.title}`,
      score: sourceWeight(kind),
    }, input);
  }

  private expandRelations(
    candidates: Map<string, RetrievedTaskCandidate>,
    input: HybridTaskRetrieverInput,
  ): void {
    if (!this.deps.taskRelationRepo) {
      return;
    }

    const seedTaskIds = Array.from(candidates.keys());
    for (const taskId of seedTaskIds) {
      const relations = [
        ...this.deps.taskRelationRepo.findBySourceTaskId(taskId),
        ...this.deps.taskRelationRepo.findByTargetTaskId(taskId),
      ];
      for (const relation of relations) {
        const relatedTaskId = relation.sourceTaskId === taskId ? relation.targetTaskId : relation.sourceTaskId;
        const task = this.deps.taskRepo.findById(relatedTaskId);
        if (!task) {
          continue;
        }
        if (shouldExcludeTask(task.id, input, 'relation')) {
          continue;
        }
        this.mergeCandidate(candidates, task, {
          kind: 'relation',
          sourceId: relation.id,
          snippet: `relation=${relation.relationType} via ${taskId}`,
          score: sourceWeight('relation'),
        }, input);
      }
    }
  }

  private addRecentCandidates(
    candidates: Map<string, RetrievedTaskCandidate>,
    input: HybridTaskRetrieverInput,
  ): void {
    for (const task of this.deps.taskRepo.findAll().slice(0, 20)) {
      if (shouldExcludeTask(task.id, input, 'recent')) {
        continue;
      }
      this.mergeCandidate(candidates, task, {
        kind: 'recent',
        sourceId: task.id,
        snippet: `最近任务：${task.title}`,
        score: sourceWeight('recent'),
      }, input);
    }
  }

  private async semanticRerankCandidates(
    candidates: Map<string, RetrievedTaskCandidate>,
    input: HybridTaskRetrieverInput,
  ): Promise<void> {
    if (!this.deps.embeddingProvider || !this.deps.taskMemoryEmbeddingRepo || candidates.size === 0) {
      return;
    }

    const [queryVector] = await this.deps.embeddingProvider.embed([buildQuery(input)]);
    if (!queryVector) {
      return;
    }

    const candidateTaskIds = Array.from(candidates.values())
      .filter(candidate => candidate.sources.some(source => source.kind !== 'recent'))
      .map(candidate => candidate.taskId);
    if (candidateTaskIds.length === 0) {
      return;
    }
    const records = this.deps.taskMemoryEmbeddingRepo.findByTaskIds
      ? this.deps.taskMemoryEmbeddingRepo.findByTaskIds(candidateTaskIds)
      : this.deps.taskMemoryEmbeddingRepo.findAll().filter(record => candidateTaskIds.includes(record.taskId));

    for (const record of records) {
      const semanticScore = cosineSimilarity(queryVector, record.vector);
      if (semanticScore < MIN_SEMANTIC_SCORE) {
        continue;
      }

      const task = this.deps.taskRepo.findById(record.taskId);
      if (!task) {
        continue;
      }
      if (shouldExcludeTask(task.id, input, 'semantic')) {
        continue;
      }

      this.mergeCandidate(candidates, task, {
        kind: 'semantic',
        sourceId: record.id,
        snippet: `${record.memoryKind} semantic=${semanticScore.toFixed(2)}`,
        score: sourceWeight('semantic') + Math.round(semanticScore * SEMANTIC_SCORE_MULTIPLIER),
      }, input);
    }
  }

  private applyTaskFeedback(
    candidates: Map<string, RetrievedTaskCandidate>,
    input: HybridTaskRetrieverInput,
  ): void {
    if (!this.deps.recallFeedbackRepo || candidates.size === 0) {
      return;
    }

    const feedbackRows = this.deps.recallFeedbackRepo.findActiveForCandidates({
      targetKind: 'task',
      targetIds: Array.from(candidates.keys()),
      queryTaskId: input.currentTaskId ?? null,
    });
    const feedbackByTask = new Map<string, RecallFeedbackAction[]>();
    for (const feedback of feedbackRows) {
      const actions = feedbackByTask.get(feedback.targetId) ?? [];
      actions.push(feedback.action);
      feedbackByTask.set(feedback.targetId, actions);
    }

    for (const [taskId, actions] of feedbackByTask) {
      if (actions.includes('hide')) {
        candidates.delete(taskId);
        continue;
      }

      const candidate = candidates.get(taskId);
      if (!candidate) {
        continue;
      }
      if (actions.includes('irrelevant')) {
        candidate.score -= 80;
        candidate.reason = `${candidate.reason}；RecallFeedback：用户曾标记为不相关，已降权`;
      }
      if (actions.includes('reject')) {
        candidate.score -= 40;
        candidate.reason = `${candidate.reason}；RecallFeedback：用户曾拒绝采用，已降权`;
      }
      if (actions.includes('select')) {
        candidate.score += 40;
        candidate.reason = `${candidate.reason}；RecallFeedback：用户曾选择采用，已加权`;
      }
    }
  }

  private mergeCandidate(
    candidates: Map<string, RetrievedTaskCandidate>,
    task: Task,
    source: {
      kind: RetrievedTaskSourceKind;
      sourceId: string;
      snippet: string;
      score: number;
    },
    input: HybridTaskRetrieverInput,
  ): void {
    const existing = candidates.get(task.id);
    const sourceAlreadyExists = existing?.sources.some(
      item => item.kind === source.kind && item.sourceId === source.sourceId,
    );

    if (existing) {
      if (!sourceAlreadyExists) {
        existing.sources.push({
          kind: source.kind,
          sourceId: source.sourceId,
          snippet: source.snippet,
        });
      }
      existing.score += source.score;
      existing.reason = this.buildReason(task, existing);
      return;
    }

    const candidate: RetrievedTaskCandidate = {
      taskId: task.id,
      score: source.score + getContinuityBonus(task, input.currentTaskId),
      recallMode: getRecallMode(task, input.currentTaskId),
      sources: [{
        kind: source.kind,
        sourceId: source.sourceId,
        snippet: source.snippet,
      }],
      artifacts: [...task.artifacts],
      pitfalls: detectPitfalls(task),
      reason: '',
    };
    candidate.reason = this.buildReason(task, candidate);
    candidates.set(task.id, candidate);
  }

  private buildReason(task: Task, candidate: RetrievedTaskCandidate): string {
    const sourceText = candidate.sources
      .map(source => `${source.kind}:${source.sourceId}`)
      .join(', ');
    const statusText = `status=${task.status}`;
    const artifactText = task.artifacts.length > 0 ? `；artifacts=${task.artifacts.length}` : '';
    return `统一任务召回命中 ${task.title}（${statusText}）；来源 ${sourceText}${artifactText}`;
  }

  private rankByTaskRelevance(
    candidates: RetrievedTaskCandidate[],
    input: HybridTaskRetrieverInput,
  ): Map<string, ReturnType<TaskRelevanceRanker['rank']>[number]> {
    if (candidates.length === 0) {
      return new Map();
    }

    const now = new Date().toISOString();
    const currentTask = input.currentTaskId
      ? this.deps.taskRepo.findById(input.currentTaskId)
      : null;
    const queryTask: Task = currentTask ?? {
      id: input.currentTaskId ?? '__query_task__',
      title: '当前查询',
      goal: input.queryText,
      status: 'running',
      summary: input.queryText,
      snapshots: [],
      resources: [],
      artifacts: [],
      dependencies: [],
      prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
      injectedPreferences: [],
      lastSchedulingReason: '',
      lastInterruptionReason: '',
      interruptionCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const tasks = candidates
      .map(candidate => this.deps.taskRepo.findById(candidate.taskId))
      .filter((task): task is Task => Boolean(task));
    return new Map(
      new TaskRelevanceRanker().rank({
        currentTask: queryTask,
        userInput: input.queryText,
        keywords: input.keywords ?? [],
        candidates: tasks,
      }).map(score => [score.taskId, score]),
    );
  }
}
