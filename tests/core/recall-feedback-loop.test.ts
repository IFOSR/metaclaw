import { describe, expect, it, vi } from 'vitest';
import { HybridMemoryRecaller } from '../../src/core/hybrid-memory-recaller.js';
import type { Preference, Task } from '../../src/core/types.js';

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

function createSemanticRecallerWithFeedback(feedbackRepo: any): HybridMemoryRecaller {
  return new HybridMemoryRecaller({
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
    recallFeedbackRepo: feedbackRepo,
  } as any);
}

describe('Recall feedback loop', () => {
  it('filters task candidates hidden by previous recall review feedback', async () => {
    const recaller = createSemanticRecallerWithFeedback({
      findActiveForCandidates: vi.fn().mockReturnValue([
        {
          id: 'fb_hide_task_sem',
          targetKind: 'task',
          targetId: 'task_sem',
          action: 'hide',
          queryTaskId: 'task_previous',
          auditId: 'recall_previous',
          createdAt: '2026-04-20T00:00:00Z',
        },
      ]),
    });

    const result = await recaller.recall({
      taskId: 'task_current',
      queryText: '继续整理 Phoenix 周报，保留风险栏目和经营数据栏目',
      keywords: ['Phoenix', '周报'],
      subject: 'Phoenix',
      rulePreferenceCandidates: [],
      ruleTaskCandidates: [],
    });

    expect(result.taskCandidates.map(candidate => candidate.taskId)).not.toContain('task_sem');
  });

  it('downranks but keeps task candidates marked irrelevant instead of injecting them directly', async () => {
    const recaller = createSemanticRecallerWithFeedback({
      findActiveForCandidates: vi.fn().mockReturnValue([
        {
          id: 'fb_irrelevant_task_sem',
          targetKind: 'task',
          targetId: 'task_sem',
          action: 'irrelevant',
          queryTaskId: 'task_previous',
          auditId: 'recall_previous',
          createdAt: '2026-04-20T00:00:00Z',
        },
      ]),
    });

    const result = await recaller.recall({
      taskId: 'task_current',
      queryText: '继续整理 Phoenix 周报，保留风险栏目和经营数据栏目',
      keywords: ['Phoenix', '周报'],
      subject: 'Phoenix',
      rulePreferenceCandidates: [],
      ruleTaskCandidates: [],
    });

    expect(result.taskCandidates[0]?.taskId).toBe('task_sem');
    expect(result.taskCandidates[0]?.score).toBeLessThan(100);
    expect(result.taskCandidates[0]?.reason).toContain('用户曾标记为不相关');
  });

  it('boosts task candidates selected by previous recall review feedback', async () => {
    const baseline = await createSemanticRecallerWithFeedback({
      findActiveForCandidates: vi.fn().mockReturnValue([]),
    }).recall({
      taskId: 'task_current',
      queryText: '继续整理 Phoenix 周报，保留风险栏目和经营数据栏目',
      keywords: ['Phoenix', '周报'],
      subject: 'Phoenix',
      rulePreferenceCandidates: [],
      ruleTaskCandidates: [],
    });

    const recaller = createSemanticRecallerWithFeedback({
      findActiveForCandidates: vi.fn().mockReturnValue([
        {
          id: 'fb_select_task_sem',
          targetKind: 'task',
          targetId: 'task_sem',
          action: 'select',
          queryTaskId: 'task_previous',
          auditId: 'recall_previous',
          createdAt: '2026-04-20T00:00:00Z',
        },
      ]),
    });

    const result = await recaller.recall({
      taskId: 'task_current',
      queryText: '继续整理 Phoenix 周报，保留风险栏目和经营数据栏目',
      keywords: ['Phoenix', '周报'],
      subject: 'Phoenix',
      rulePreferenceCandidates: [],
      ruleTaskCandidates: [],
    });

    expect(result.taskCandidates[0]?.taskId).toBe('task_sem');
    expect(result.taskCandidates[0]?.score).toBeGreaterThan(baseline.taskCandidates[0]?.score ?? 0);
    expect(result.taskCandidates[0]?.reason).toContain('用户曾选择采用');
  });
});
