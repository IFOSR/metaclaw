import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { GuidanceRepo } from '../../src/storage/guidance-repo.js';
import { RecallReviewPolicyRepo } from '../../src/storage/recall-review-policy-repo.js';
import { TaskRelationRepo } from '../../src/storage/task-relation-repo.js';

describe('GuidanceRepo', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('persists and updates a proposal lifecycle event', () => {
    const repo = new GuidanceRepo(db);

    repo.insert({
      id: 'guid_1',
      trigger: 'startup',
      taskId: 'task_1',
      actionType: 'resume_task',
      payload: { taskId: 'task_1', source: 'startup' },
      reasons: ['材料已齐'],
      confidence: 0.92,
      requiresConfirmation: true,
      acceptedAt: null,
      dismissedAt: null,
      executedAt: null,
      createdAt: '2026-04-20T00:00:00Z',
    });

    repo.markAccepted('guid_1', '2026-04-20T00:02:00Z');
    repo.markExecuted('guid_1', '2026-04-20T00:05:00Z');

    const row = repo.findById('guid_1');
    expect(row).not.toBeNull();
    expect(row?.actionType).toBe('resume_task');
    expect(row?.payload).toEqual({ taskId: 'task_1', source: 'startup' });
    expect(row?.reasons).toEqual(['材料已齐']);
    expect(row?.requiresConfirmation).toBe(true);
    expect(row?.acceptedAt).toBe('2026-04-20T00:02:00Z');
    expect(row?.executedAt).toBe('2026-04-20T00:05:00Z');
  });
});

describe('RecallReviewPolicyRepo', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('upserts and finds policies by lookup fields', () => {
    const repo = new RecallReviewPolicyRepo(db);

    repo.upsert({
      id: 'policy_1',
      policyType: 'project_preference',
      scope: 'project',
      subject: 'phoenix',
      proposalType: 'resume_task',
      autoApply: false,
      createdAt: '2026-04-20T00:00:00Z',
      updatedAt: '2026-04-20T00:00:00Z',
    });

    repo.upsert({
      id: 'policy_2',
      policyType: 'proposal_type',
      scope: null,
      subject: null,
      proposalType: 'resume_task',
      autoApply: true,
      createdAt: '2026-04-20T00:01:00Z',
      updatedAt: '2026-04-20T00:01:00Z',
    });

    repo.upsert({
      id: 'policy_1',
      policyType: 'project_preference',
      scope: 'project',
      subject: 'phoenix',
      proposalType: 'resume_task',
      autoApply: true,
      createdAt: '2026-04-20T00:00:00Z',
      updatedAt: '2026-04-20T00:02:00Z',
    });

    const exactMatch = repo.findMatching({
      policyType: 'project_preference',
      scope: 'project',
      subject: 'phoenix',
      proposalType: 'resume_task',
    });

    const fallbackMatch = repo.findMatching({
      policyType: 'proposal_type',
      scope: null,
      subject: null,
      proposalType: 'resume_task',
    });

    expect(exactMatch).not.toBeNull();
    expect(exactMatch?.autoApply).toBe(true);
    expect(exactMatch?.updatedAt).toBe('2026-04-20T00:02:00Z');
    expect(fallbackMatch?.id).toBe('policy_2');
    expect(repo.findAll()).toHaveLength(2);
  });
});

describe('TaskRelationRepo', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('persists relations and finds them from both ends', () => {
    const repo = new TaskRelationRepo(db);

    repo.insert({
      id: 'rel_1',
      sourceTaskId: 'task_1',
      targetTaskId: 'task_2',
      relationType: 'follow_up',
      createdAt: '2026-04-20T00:00:00Z',
    });

    repo.insert({
      id: 'rel_2',
      sourceTaskId: 'task_1',
      targetTaskId: 'task_3',
      relationType: 'blocks',
      createdAt: '2026-04-20T00:01:00Z',
    });

    expect(repo.findBySourceTaskId('task_1')).toHaveLength(2);
    expect(repo.findByTargetTaskId('task_2')[0]?.relationType).toBe('follow_up');
  });
});
