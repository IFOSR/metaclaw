import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import type {
  GuidanceProposal,
  PreferenceMemoryCandidate,
  RecallReviewCard,
  RecallReviewPolicy,
  TaskMemoryCandidate,
} from '../../src/core/types.js';

describe('V2 schema', () => {
  it('creates guidance and memory review tables', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row: { name: string }) => row.name);

    expect(tableNames).toContain('guidance_events');
    expect(tableNames).toContain('task_relations');
    expect(tableNames).toContain('task_memory_embeddings');
    expect(tableNames).toContain('preference_embeddings');
    expect(tableNames).toContain('memory_recall_events');
    expect(tableNames).toContain('recall_review_policies');
  });
});

describe('V2 core types', () => {
  it('supports proposal and recall review shapes', () => {
    const proposal: GuidanceProposal = {
      id: 'guid_1',
      trigger: 'startup',
      taskId: 'task_1',
      actionType: 'resume_task',
      recommendedAction: '恢复任务 #task_1',
      reasons: ['材料已齐', '上次下一步明确'],
      confidence: 0.92,
      requiresConfirmation: true,
      proposalPayload: { taskId: 'task_1' },
      expiresAt: '2026-04-20T01:00:00Z',
      createdAt: '2026-04-20T00:00:00Z',
    };

    const taskCandidate: TaskMemoryCandidate = {
      id: 'task_mem_1',
      taskId: 'task_1',
      sourceTaskId: 'task_9',
      memoryKind: 'task_summary',
      title: '上周 Phoenix 周报',
      summary: '结构高度相似，可复用表格结构',
      reason: '与当前任务目标相似',
      source: 'semantic',
      score: 0.88,
      artifactPaths: ['/tmp/phoenix-weekly.md'],
    };

    const preferenceCandidate: PreferenceMemoryCandidate = {
      id: 'pref_mem_1',
      preferenceId: 'pref_1',
      scope: 'project',
      subject: 'phoenix',
      summary: 'Phoenix 统一用 Phoenix 术语体系',
      reason: '与当前项目语义相近',
      source: 'rule',
      score: 0.9,
    };

    const reviewCard: RecallReviewCard = {
      taskMemorySummary: [
        {
          label: taskCandidate.title,
          summary: taskCandidate.summary,
          reason: taskCandidate.reason,
        },
      ],
      preferenceMemorySummary: [
        {
          scope: preferenceCandidate.scope,
          summary: preferenceCandidate.summary,
          reason: preferenceCandidate.reason,
        },
      ],
      options: ['accept_all', 'reject_all', 'edit', 'select_partial', 'auto_apply_future'],
    };

    const policy: RecallReviewPolicy = {
      id: 'policy_1',
      policyType: 'project_preference',
      scope: 'project',
      subject: 'phoenix',
      proposalType: 'resume_task',
      autoApply: true,
      createdAt: '2026-04-20T00:00:00Z',
      updatedAt: '2026-04-20T00:00:00Z',
    };

    expect(proposal.actionType).toBe('resume_task');
    expect(reviewCard.taskMemorySummary[0]?.label).toBe('上周 Phoenix 周报');
    expect(reviewCard.options).toContain('auto_apply_future');
    expect(policy.autoApply).toBe(true);
  });
});
