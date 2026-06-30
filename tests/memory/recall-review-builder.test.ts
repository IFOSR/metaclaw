import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { RecallReviewBuilder } from '../../src/memory/recall-review-builder.js';
import { RecallPolicyService } from '../../src/memory/recall-policy-service.js';
import { RecallReviewPolicyRepo } from '../../src/storage/recall-review-policy-repo.js';
import type {
  PreferenceMemoryCandidate,
  TaskMemoryCandidate,
} from '../../src/core/types.js';

function createTaskCandidate(overrides: Partial<TaskMemoryCandidate> = {}): TaskMemoryCandidate {
  return {
    id: 'task_mem_1',
    taskId: 'task_current',
    sourceTaskId: 'task_prev',
    memoryKind: 'task_summary',
    title: '上周 Phoenix 周报',
    summary: '结构和当前周报高度相似，可复用栏目顺序与风险段落。',
    reason: '与当前任务目标相似',
    source: 'semantic',
    score: 0.92,
    artifactPaths: ['/tmp/phoenix-report.md'],
    ...overrides,
  };
}

function createPreferenceCandidate(
  overrides: Partial<PreferenceMemoryCandidate> = {},
): PreferenceMemoryCandidate {
  return {
    id: 'pref_mem_1',
    preferenceId: 'pref_1',
    scope: 'project',
    subject: 'Phoenix',
    summary: 'Phoenix 项目默认使用 Phoenix 术语体系，避免混用旧代号。',
    reason: '项目术语语义相近',
    source: 'semantic',
    score: 0.88,
    ...overrides,
  };
}

describe('RecallReviewBuilder', () => {
  it('builds a concise review card instead of exposing raw recall payloads', () => {
    const builder = new RecallReviewBuilder();

    const card = builder.build({
      taskCandidates: [
        createTaskCandidate({
          id: 'task_mem_low',
          title: '更早的一版周报',
          summary: '这是一个较旧但仍然相关的周报结构。',
          score: 0.6,
          artifactPaths: [],
        }),
        createTaskCandidate(),
      ],
      preferenceCandidates: [createPreferenceCandidate()],
    });

    expect(card.taskMemorySummary).toEqual([
      {
        label: '上周 Phoenix 周报',
        summary: '结构和当前周报高度相似，可复用栏目顺序与风险段落。可复用附件 1 份。',
        reason: '与当前任务目标相似',
      },
      {
        label: '更早的一版周报',
        summary: '这是一个较旧但仍然相关的周报结构。',
        reason: '与当前任务目标相似',
      },
    ]);
    expect(card.preferenceMemorySummary).toEqual([
      {
        scope: 'project',
        summary: 'Phoenix 项目默认使用 Phoenix 术语体系，避免混用旧代号。',
        reason: '项目术语语义相近',
      },
    ]);
    expect(card.options).toEqual([
      'accept_all',
      'reject_all',
      'select_partial',
      'edit',
      'auto_apply_future',
    ]);

    const rendered = JSON.stringify(card);
    expect(rendered).not.toContain('task_mem_1');
    expect(rendered).not.toContain('pref_mem_1');
    expect(rendered).not.toContain('sourceTaskId');
    expect(rendered).not.toContain('artifactPaths');
  });
});

describe('RecallPolicyService', () => {
  let db: Database.Database;
  let repo: RecallReviewPolicyRepo;
  let service: RecallPolicyService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    repo = new RecallReviewPolicyRepo(db);
    service = new RecallPolicyService(repo);
  });

  it('requires review by default when no matching auto-apply policy exists', () => {
    const decision = service.resolve({
      proposalType: 'resume_task',
      taskCandidates: [createTaskCandidate()],
      preferenceCandidates: [createPreferenceCandidate()],
    });

    expect(decision.requiresReview).toBe(true);
    expect(decision.autoApply).toBe(false);
    expect(decision.matchedPolicies).toHaveLength(0);
    expect(decision.uncoveredCategories).toEqual(['task_memory', 'project:Phoenix']);
  });

  it('skips review only when every recalled category is explicitly allowed', () => {
    repo.upsert({
      id: 'policy_task_memory',
      policyType: 'task_memory',
      scope: null,
      subject: null,
      proposalType: null,
      autoApply: true,
      createdAt: '2026-04-20T00:00:00Z',
      updatedAt: '2026-04-20T00:00:00Z',
    });
    repo.upsert({
      id: 'policy_project_phoenix',
      policyType: 'project_preference',
      scope: 'project',
      subject: 'Phoenix',
      proposalType: null,
      autoApply: true,
      createdAt: '2026-04-20T00:00:00Z',
      updatedAt: '2026-04-20T00:00:00Z',
    });

    const decision = service.resolve({
      proposalType: 'resume_task',
      taskCandidates: [createTaskCandidate()],
      preferenceCandidates: [createPreferenceCandidate()],
    });

    expect(decision.requiresReview).toBe(false);
    expect(decision.autoApply).toBe(true);
    expect(decision.matchedPolicies.map(policy => policy.id)).toEqual([
      'policy_task_memory',
      'policy_project_phoenix',
    ]);
    expect(decision.uncoveredCategories).toEqual([]);
  });

  it('lets a proposal-type policy bypass review in a deterministic way', () => {
    repo.upsert({
      id: 'policy_resume_task',
      policyType: 'proposal_type',
      scope: null,
      subject: null,
      proposalType: 'resume_task',
      autoApply: true,
      createdAt: '2026-04-20T00:00:00Z',
      updatedAt: '2026-04-20T00:00:00Z',
    });

    const decision = service.resolve({
      proposalType: 'resume_task',
      taskCandidates: [createTaskCandidate()],
      preferenceCandidates: [createPreferenceCandidate()],
    });

    expect(decision.requiresReview).toBe(false);
    expect(decision.autoApply).toBe(true);
    expect(decision.matchedPolicies.map(policy => policy.id)).toEqual(['policy_resume_task']);
    expect(decision.uncoveredCategories).toEqual([]);
  });
});
