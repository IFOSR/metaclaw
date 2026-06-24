import { describe, expect, it, vi } from 'vitest';
import { RecallReviewApplicationService } from '../../src/core/recall-review-application-service.js';
import type { PreferenceMemoryCandidate, TaskMemoryCandidate } from '../../src/core/types.js';

function preference(overrides: Partial<PreferenceMemoryCandidate> = {}): PreferenceMemoryCandidate {
  return {
    id: 'pref_candidate_1',
    preferenceId: 'pref_1',
    scope: 'project',
    subject: 'Phoenix',
    summary: 'use Phoenix terminology',
    reason: 'project match',
    source: 'semantic',
    score: 0.9,
    ...overrides,
  };
}

function taskMemory(overrides: Partial<TaskMemoryCandidate> = {}): TaskMemoryCandidate {
  return {
    id: 'task_mem_1',
    taskId: 'task_current',
    sourceTaskId: 'task_previous',
    memoryKind: 'task_summary',
    title: 'previous task',
    summary: 'previous summary',
    reason: 'similar task',
    source: 'semantic',
    score: 0.8,
    artifactPaths: [],
    ...overrides,
  };
}

function createService(options: {
  requiresReview: boolean;
  autoAppliedPreferenceCandidates?: PreferenceMemoryCandidate[];
  reviewPreferenceCandidates?: PreferenceMemoryCandidate[];
  autoAppliedTaskCandidates?: TaskMemoryCandidate[];
  reviewTaskCandidates?: TaskMemoryCandidate[];
}) {
  const buildAcceptedRecallSelection = vi.fn((preferences: PreferenceMemoryCandidate[], tasks: TaskMemoryCandidate[]) => ({
    authoritative: true,
    resolvedPreferences: preferences.map(candidate => ({
      id: candidate.preferenceId,
      scope: candidate.scope,
      content: candidate.summary,
      confidence: 0.9,
      reason: candidate.reason,
    })),
    relatedTaskIds: tasks.map(candidate => candidate.taskId),
    acceptedMemoryResources: tasks.flatMap(candidate => candidate.artifactPaths),
  }));
  const auditMemory = vi.fn();
  const formatAutoAppliedMemoryBlock = vi.fn(() => ['auto block']);
  const formatSuppressedRecallBlock = vi.fn(() => ['suppressed block']);

  const service = new RecallReviewApplicationService({
    memoryContextService: {
      prepareRecallReviewContext: vi.fn().mockResolvedValue({
        autoAppliedPreferenceCandidates: options.autoAppliedPreferenceCandidates ?? [],
        reviewPreferenceCandidates: options.reviewPreferenceCandidates ?? [],
        autoAppliedTaskCandidates: options.autoAppliedTaskCandidates ?? [],
        reviewTaskCandidates: options.reviewTaskCandidates ?? [],
      }),
      buildAcceptedRecallSelection,
    },
    recallPolicyService: {
      resolve: vi.fn().mockReturnValue({
        requiresReview: options.requiresReview,
        autoApply: !options.requiresReview,
        matchedPolicies: [],
        uncoveredCategories: options.requiresReview ? ['project:Phoenix'] : [],
      }),
    },
    memoryCaptureService: { auditMemory },
    formatters: {
      formatAutoAppliedMemoryBlock,
      formatSuppressedRecallBlock,
    },
  });

  return {
    service,
    buildAcceptedRecallSelection,
    auditMemory,
    formatAutoAppliedMemoryBlock,
    formatSuppressedRecallBlock,
  };
}

describe('RecallReviewApplicationService', () => {
  it('auto-applies review candidates when policy allows them', async () => {
    const candidate = preference();
    const taskCandidate = taskMemory();
    const { service, auditMemory, formatAutoAppliedMemoryBlock, formatSuppressedRecallBlock } = createService({
      requiresReview: false,
      reviewPreferenceCandidates: [candidate],
      reviewTaskCandidates: [taskCandidate],
    });

    const result = await service.apply({
      taskId: 'task_current',
      taskTitle: 'current task',
      userPrompt: 'do it',
      proposalType: null,
    });

    expect(result.lines).toEqual(['auto block']);
    expect(result.approvedSelection.resolvedPreferences).toHaveLength(1);
    expect(result.approvedSelection.relatedTaskIds).toEqual(['task_current']);
    expect(auditMemory).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auto_apply',
      memoryId: 'pref_1',
    }));
    expect(formatAutoAppliedMemoryBlock).toHaveBeenCalledWith(expect.objectContaining({
      preferenceCandidates: [candidate],
      taskCandidates: [taskCandidate],
    }));
    expect(formatSuppressedRecallBlock).not.toHaveBeenCalled();
  });

  it('suppresses review candidates when policy requires review in a non-interactive path', async () => {
    const candidate = preference();
    const autoCandidate = preference({ id: 'pref_candidate_auto', preferenceId: 'pref_auto' });
    const { service, auditMemory, formatAutoAppliedMemoryBlock, formatSuppressedRecallBlock } = createService({
      requiresReview: true,
      autoAppliedPreferenceCandidates: [autoCandidate],
      reviewPreferenceCandidates: [candidate],
    });

    const result = await service.apply({
      taskId: 'task_current',
      taskTitle: 'current task',
      userPrompt: 'do it',
      proposalType: null,
    });

    expect(result.lines).toEqual(['auto block', 'suppressed block']);
    expect(result.approvedSelection.resolvedPreferences.map(item => item.id)).toEqual(['pref_auto']);
    expect(auditMemory).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auto_apply',
      memoryId: 'pref_auto',
    }));
    expect(auditMemory).toHaveBeenCalledWith(expect.objectContaining({
      action: 'suppress',
      memoryId: 'pref_1',
    }));
    expect(formatAutoAppliedMemoryBlock).toHaveBeenCalledTimes(1);
    expect(formatSuppressedRecallBlock).toHaveBeenCalledWith(expect.objectContaining({
      preferenceCount: 1,
      taskMemoryCount: 0,
    }));
  });
});
