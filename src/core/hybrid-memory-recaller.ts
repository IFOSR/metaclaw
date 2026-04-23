import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { EmbeddingProvider } from './embedding-provider.js';
import {
  PreferenceScope,
  type Preference,
  type PreferenceMemoryCandidate,
  type Task,
  type TaskMemoryCandidate,
  type TaskMemoryKind,
} from './types.js';
import type { PreferenceEmbeddingRecord } from '../storage/preference-embedding-repo.js';
import type { TaskMemoryEmbeddingRecord } from '../storage/task-memory-embedding-repo.js';
import type { MemoryRecallEventRecord } from '../storage/memory-recall-event-repo.js';

interface PreferenceRepoLike {
  findById(id: string): Preference | null;
}

interface TaskRepoLike {
  findById(id: string): Task | null;
}

interface PreferenceEmbeddingRepoLike {
  findAll(): PreferenceEmbeddingRecord[];
}

interface TaskMemoryEmbeddingRepoLike {
  findAll(): TaskMemoryEmbeddingRecord[];
}

interface MemoryRecallEventRepoLike {
  insert(record: MemoryRecallEventRecord): void;
}

interface HybridMemoryRecallerDeps {
  embeddingProvider?: EmbeddingProvider;
  preferenceRepo?: PreferenceRepoLike;
  taskRepo?: TaskRepoLike;
  preferenceEmbeddingRepo?: PreferenceEmbeddingRepoLike;
  taskMemoryEmbeddingRepo?: TaskMemoryEmbeddingRepoLike;
  memoryRecallEventRepo?: MemoryRecallEventRepoLike;
}

export interface HybridMemoryRecallInput {
  taskId?: string;
  queryText: string;
  keywords: string[];
  subject?: string;
  rulePreferenceCandidates: PreferenceMemoryCandidate[];
  ruleTaskCandidates: TaskMemoryCandidate[];
  topK?: number;
}

export interface HybridMemoryMergeInput {
  rulePreferenceCandidates: PreferenceMemoryCandidate[];
  semanticPreferenceCandidates: PreferenceMemoryCandidate[];
  ruleTaskCandidates: TaskMemoryCandidate[];
  semanticTaskCandidates: TaskMemoryCandidate[];
  topK?: number;
}

export interface HybridMemoryRecallResult {
  preferenceCandidates: PreferenceMemoryCandidate[];
  taskCandidates: TaskMemoryCandidate[];
  auditId: string | null;
}

const DEFAULT_TOP_K = 5;
const SEMANTIC_SCORE_MULTIPLIER = 100;
const MIN_SEMANTIC_SCORE = 0.35;

const SCOPE_BONUS: Record<PreferenceScope, number> = {
  'task-local': 40,
  contact: 30,
  project: 20,
  global: 10,
};

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

function createRecallId(): string {
  return `recall_${nanoid(10)}`;
}

function hashQuery(queryText: string): string {
  return createHash('sha256').update(queryText).digest('hex');
}

export class HybridMemoryRecaller {
  constructor(private deps: HybridMemoryRecallerDeps = {}) {}

  async merge(input: HybridMemoryMergeInput): Promise<Omit<HybridMemoryRecallResult, 'auditId'>> {
    const preferenceCandidates = this.mergePreferenceCandidates(input).slice(0, input.topK ?? DEFAULT_TOP_K);
    const taskCandidates = this.mergeTaskCandidates(input).slice(0, input.topK ?? DEFAULT_TOP_K);

    return {
      preferenceCandidates,
      taskCandidates,
    };
  }

  async recall(input: HybridMemoryRecallInput): Promise<HybridMemoryRecallResult> {
    const semanticPreferenceCandidates = await this.buildSemanticPreferenceCandidates(input);
    const semanticTaskCandidates = await this.buildSemanticTaskCandidates(input);
    const merged = await this.merge({
      rulePreferenceCandidates: input.rulePreferenceCandidates,
      semanticPreferenceCandidates,
      ruleTaskCandidates: input.ruleTaskCandidates,
      semanticTaskCandidates,
      topK: input.topK,
    });

    const auditId = this.persistAudit(input, merged);
    return {
      ...merged,
      auditId,
    };
  }

  private async buildSemanticPreferenceCandidates(
    input: HybridMemoryRecallInput,
  ): Promise<PreferenceMemoryCandidate[]> {
    if (
      !this.deps.embeddingProvider
      || !this.deps.preferenceEmbeddingRepo
      || !this.deps.preferenceRepo
    ) {
      return [];
    }

    const [queryVector] = await this.deps.embeddingProvider.embed([this.buildQueryText(input)]);
    if (!queryVector) {
      return [];
    }

    const candidates: PreferenceMemoryCandidate[] = [];

    for (const record of this.deps.preferenceEmbeddingRepo.findAll()) {
      const preference = this.deps.preferenceRepo.findById(record.preferenceId);
      if (!preference || preference.status !== 'confirmed') {
        continue;
      }

      const semanticScore = cosineSimilarity(queryVector, record.vector);
      if (semanticScore < MIN_SEMANTIC_SCORE) {
        continue;
      }

      candidates.push({
        id: preference.id,
        preferenceId: preference.id,
        scope: preference.scope,
        subject: preference.subject,
        summary: preference.content,
        reason: this.buildPreferenceReason(preference, input, semanticScore),
        source: 'semantic',
        score: Math.round(semanticScore * SEMANTIC_SCORE_MULTIPLIER) + (SCOPE_BONUS[preference.scope] ?? 0),
      });
    }

    return candidates
      .sort((left, right) => right.score - left.score)
      .slice(0, input.topK ?? DEFAULT_TOP_K);
  }

  private async buildSemanticTaskCandidates(
    input: HybridMemoryRecallInput,
  ): Promise<TaskMemoryCandidate[]> {
    if (
      !this.deps.embeddingProvider
      || !this.deps.taskMemoryEmbeddingRepo
      || !this.deps.taskRepo
    ) {
      return [];
    }

    const [queryVector] = await this.deps.embeddingProvider.embed([this.buildQueryText(input)]);
    if (!queryVector) {
      return [];
    }

    const candidates: TaskMemoryCandidate[] = [];

    for (const record of this.deps.taskMemoryEmbeddingRepo.findAll()) {
      if (record.taskId === input.taskId) {
        continue;
      }

      const task = this.deps.taskRepo.findById(record.taskId);
      if (!task) {
        continue;
      }

      const semanticScore = cosineSimilarity(queryVector, record.vector);
      if (semanticScore < MIN_SEMANTIC_SCORE) {
        continue;
      }

      candidates.push({
        id: `${task.id}:${record.memoryKind}`,
        taskId: task.id,
        sourceTaskId: task.id,
        memoryKind: record.memoryKind,
        title: task.title,
        summary: this.buildTaskSummary(task, record.memoryKind),
        reason: this.buildTaskReason(task, input, semanticScore),
        source: 'semantic',
        score: Math.round(semanticScore * SEMANTIC_SCORE_MULTIPLIER) + this.getTaskContinuityBonus(task, input),
        artifactPaths: [...task.artifacts],
      });
    }

    return candidates
      .sort((left, right) => right.score - left.score)
      .slice(0, input.topK ?? DEFAULT_TOP_K);
  }

  private mergePreferenceCandidates(input: HybridMemoryMergeInput): PreferenceMemoryCandidate[] {
    const merged = new Map<string, PreferenceMemoryCandidate>();

    for (const candidate of [
      ...input.rulePreferenceCandidates,
      ...input.semanticPreferenceCandidates,
    ]) {
      const existing = merged.get(candidate.id);
      if (!existing || candidate.score > existing.score) {
        merged.set(candidate.id, candidate);
      }
    }

    return Array.from(merged.values()).sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.summary.localeCompare(right.summary, 'zh-Hans-CN');
    });
  }

  private mergeTaskCandidates(input: HybridMemoryMergeInput): TaskMemoryCandidate[] {
    const merged = new Map<string, TaskMemoryCandidate>();

    for (const candidate of [
      ...input.ruleTaskCandidates,
      ...input.semanticTaskCandidates,
    ]) {
      const existing = merged.get(candidate.id);
      if (!existing || candidate.score > existing.score) {
        merged.set(candidate.id, candidate);
      }
    }

    return Array.from(merged.values()).sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.title.localeCompare(right.title, 'zh-Hans-CN');
    });
  }

  private buildQueryText(input: HybridMemoryRecallInput): string {
    return [
      input.queryText,
      input.subject ? `主体：${input.subject}` : '',
      input.keywords.length > 0 ? `关键词：${input.keywords.join(' ')}` : '',
    ].filter(Boolean).join('\n');
  }

  private buildPreferenceReason(
    preference: Preference,
    input: HybridMemoryRecallInput,
    semanticScore: number,
  ): string {
    if (input.subject && preference.subject === input.subject) {
      return `命中主体且语义相近（${semanticScore.toFixed(2)}）`;
    }

    return `与当前输入语义相近（${semanticScore.toFixed(2)}）`;
  }

  private buildTaskReason(task: Task, input: HybridMemoryRecallInput, semanticScore: number): string {
    if (input.subject && (task.title.includes(input.subject) || task.goal.includes(input.subject))) {
      return `与当前主体相关且任务目标语义相近（${semanticScore.toFixed(2)}）`;
    }

    return `与当前任务目标语义相近（${semanticScore.toFixed(2)}）`;
  }

  private buildTaskSummary(task: Task, memoryKind: TaskMemoryKind): string {
    const latestSnapshot = task.snapshots[task.snapshots.length - 1];
    if (memoryKind === 'snapshot_summary' && latestSnapshot) {
      return [
        latestSnapshot.done.length > 0 ? `已完成：${latestSnapshot.done.join('；')}` : '',
        latestSnapshot.pending.length > 0 ? `待处理：${latestSnapshot.pending.join('；')}` : '',
      ].filter(Boolean).join('；') || task.summary || task.goal;
    }

    if (memoryKind === 'material_summary') {
      return task.resources.length > 0
        ? `该任务关联 ${task.resources.length} 份材料，可用于快速复用上下文`
        : '该任务未记录材料摘要';
    }

    if (memoryKind === 'artifact_summary') {
      return task.artifacts.length > 0
        ? `该任务产出 ${task.artifacts.length} 份附件，可直接参考`
        : '该任务暂无可复用附件';
    }

    return task.summary || task.goal;
  }

  private getTaskContinuityBonus(task: Task, input: HybridMemoryRecallInput): number {
    if (!input.subject) {
      return 0;
    }

    return task.title.includes(input.subject) || task.goal.includes(input.subject) ? 20 : 0;
  }

  private persistAudit(
    input: HybridMemoryRecallInput,
    merged: Omit<HybridMemoryRecallResult, 'auditId'>,
  ): string | null {
    if (!this.deps.memoryRecallEventRepo) {
      return null;
    }

    const now = new Date().toISOString();
    const auditId = createRecallId();
    this.deps.memoryRecallEventRepo.insert({
      id: auditId,
      taskId: input.taskId ?? null,
      queryText: input.queryText,
      queryHash: hashQuery(input.queryText),
      taskCandidates: merged.taskCandidates,
      preferenceCandidates: merged.preferenceCandidates,
      reviewSummary: {},
      acceptedCandidates: [],
      createdAt: now,
    });

    return auditId;
  }
}
