import { afterEach, describe, expect, it, vi } from 'vitest';
import { HybridMemoryRecaller } from '../../src/core/hybrid-memory-recaller.js';
import type { Preference, Task } from '../../src/core/types.js';

function createPreference(overrides: Partial<Preference> = {}): Preference {
  return {
    id: 'pref_sem',
    type: 'domain',
    scope: 'project',
    subject: 'Phoenix',
    content: 'Phoenix 项目周报统一保留风险栏目和经营数据栏目',
    status: 'confirmed',
    confidence: 1,
    occurrenceCount: 3,
    sourceTasks: ['task_old'],
    lastUsedAt: null,
    confirmedAt: '2026-04-20T00:00:00Z',
    createdAt: '2026-04-20T00:00:00Z',
    updatedAt: '2026-04-20T00:00:00Z',
    ...overrides,
  };
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_sem',
    title: '上周 Phoenix 周报',
    goal: '整理上周 Phoenix 周报',
    status: 'done',
    summary: '已整理风险栏目和经营数据栏目，可复用结构',
    snapshots: [{
      done: ['完成风险栏目'],
      pending: [],
      nextStep: '复用结构输出本周周报',
      pauseReason: '已完成',
      createdAt: '2026-04-20T00:00:00Z',
    }],
    resources: ['/tmp/phoenix-weekly-last.md'],
    artifacts: ['/tmp/phoenix-weekly-last-output.md'],
    dependencies: [],
    prioritySignals: {
      dueAt: null,
      isReady: true,
      progressRatio: 1,
      blocksOthers: false,
      idleHours: 10,
    },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: '2026-04-19T00:00:00Z',
    updatedAt: '2026-04-20T00:00:00Z',
    ...overrides,
  };
}

describe('HybridMemoryRecaller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges rule recall and semantic recall before building review candidates', async () => {
    const recaller = new HybridMemoryRecaller();

    const result = await recaller.merge({
      rulePreferenceCandidates: [{
        id: 'pref_rule',
        preferenceId: 'pref_rule',
        scope: 'global',
        subject: null,
        summary: '默认输出简洁',
        reason: '命中当前输入关键词',
        source: 'rule',
        score: 200,
      }],
      semanticPreferenceCandidates: [{
        id: 'pref_sem',
        preferenceId: 'pref_sem',
        scope: 'project',
        subject: 'Phoenix',
        summary: 'Phoenix 统一保留风险栏目',
        reason: '与当前输入语义相近',
        source: 'semantic',
        score: 81,
      }],
      ruleTaskCandidates: [{
        id: 'task_rule',
        taskId: 'task_rule',
        sourceTaskId: 'task_rule',
        memoryKind: 'task_summary',
        title: '上次周报整理',
        summary: '结构接近，可复用',
        reason: '连续任务',
        source: 'continuity',
        score: 100,
        artifactPaths: [],
      }],
      semanticTaskCandidates: [{
        id: 'task_sem',
        taskId: 'task_sem',
        sourceTaskId: 'task_sem',
        memoryKind: 'task_summary',
        title: '上周 Phoenix 周报',
        summary: '与当前任务目标高度相似',
        reason: '与当前任务目标语义相近',
        source: 'semantic',
        score: 88,
        artifactPaths: ['/tmp/phoenix-weekly-last-output.md'],
      }],
    });

    expect(result.preferenceCandidates.map(candidate => candidate.id)).toContain('pref_rule');
    expect(result.preferenceCandidates.map(candidate => candidate.id)).toContain('pref_sem');
    expect(result.taskCandidates.map(candidate => candidate.id)).toContain('task_rule');
    expect(result.taskCandidates.map(candidate => candidate.id)).toContain('task_sem');
  });

  it('builds semantic preference and task candidates and persists recall audit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T00:00:00Z'));

    const auditRepo = {
      insert: vi.fn(),
    };
    const recaller = new HybridMemoryRecaller({
      embeddingProvider: {
        provider: 'test-provider',
        model: 'test-model',
        embed: vi.fn().mockResolvedValue([[1, 0]]),
      },
      preferenceEmbeddingRepo: {
        findAll: vi.fn().mockReturnValue([{
          id: 'prefemb_1',
          preferenceId: 'pref_sem',
          provider: 'test-provider',
          model: 'test-model',
          dimension: 2,
          vector: [0.98, 0.02],
          contentHash: 'hash_pref',
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
        }]),
      },
      taskMemoryEmbeddingRepo: {
        findAll: vi.fn().mockReturnValue([{
          id: 'taskemb_1',
          taskId: 'task_sem',
          memoryKind: 'task_summary',
          sourceId: 'task_sem',
          provider: 'test-provider',
          model: 'test-model',
          dimension: 2,
          vector: [0.95, 0.05],
          contentHash: 'hash_task',
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
        }]),
      },
      preferenceRepo: {
        findById: vi.fn().mockReturnValue(createPreference()),
      },
      taskRepo: {
        findById: vi.fn().mockReturnValue(createTask()),
      },
      memoryRecallEventRepo: auditRepo as any,
    });

    const result = await recaller.recall({
      taskId: 'task_current',
      queryText: '继续整理 Phoenix 周报，保留风险栏目和经营数据栏目',
      keywords: ['Phoenix', '周报'],
      subject: 'Phoenix',
      rulePreferenceCandidates: [],
      ruleTaskCandidates: [],
    });

    expect(result.preferenceCandidates[0]?.id).toBe('pref_sem');
    expect(result.preferenceCandidates[0]?.source).toBe('semantic');
    expect(result.taskCandidates[0]?.id).toBe('task_sem:task_summary');
    expect(result.taskCandidates[0]?.artifactPaths).toEqual(['/tmp/phoenix-weekly-last-output.md']);
    expect(result.taskCandidates[0]?.reason).toContain('TaskRelevanceRanker');
    expect(result.taskCandidates[0]?.reason).toContain('inject');
    expect(result.auditId).toMatch(/^recall_/);
    expect(auditRepo.insert).toHaveBeenCalledTimes(1);
  });

  it('filters semantic preference and task candidates below the high-confidence threshold', async () => {
    const recaller = new HybridMemoryRecaller({
      embeddingProvider: {
        provider: 'test-provider',
        model: 'test-model',
        embed: vi.fn().mockResolvedValue([[1, 0]]),
      },
      preferenceEmbeddingRepo: {
        findAll: vi.fn().mockReturnValue([{
          id: 'prefemb_low',
          preferenceId: 'pref_sem',
          provider: 'test-provider',
          model: 'test-model',
          dimension: 2,
          vector: [0.5, Math.sqrt(0.75)],
          contentHash: 'hash_pref_low',
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
        }]),
      },
      taskMemoryEmbeddingRepo: {
        findAll: vi.fn().mockReturnValue([{
          id: 'taskemb_low',
          taskId: 'task_sem',
          memoryKind: 'task_summary',
          sourceId: 'task_sem',
          provider: 'test-provider',
          model: 'test-model',
          dimension: 2,
          vector: [0.5, Math.sqrt(0.75)],
          contentHash: 'hash_task_low',
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
        }]),
      },
      preferenceRepo: {
        findById: vi.fn().mockReturnValue(createPreference()),
      },
      taskRepo: {
        findById: vi.fn().mockReturnValue(createTask()),
      },
    });

    const result = await recaller.recall({
      taskId: 'task_current',
      queryText: '继续整理 Phoenix 周报，保留风险栏目和经营数据栏目',
      keywords: ['Phoenix', '周报'],
      subject: 'Phoenix',
      rulePreferenceCandidates: [],
      ruleTaskCandidates: [],
    });

    expect(result.preferenceCandidates).toHaveLength(0);
    expect(result.taskCandidates).toHaveLength(0);
  });
});
