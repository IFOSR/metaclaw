import type { GuidanceActionType, PreferenceMemoryCandidate, TaskMemoryCandidate } from './types.js';
import type { ExecutionRecallSelection, MemoryContextService } from './memory-context-service.js';
import type { MemoryCaptureService } from './memory-capture-service.js';
import type { RecallPolicyService } from './recall-policy-service.js';

export interface RecallReviewApplicationInput {
  taskId: string;
  taskTitle: string;
  userPrompt: string;
  proposalType: GuidanceActionType | null;
}

export interface RecallReviewApplicationResult {
  approvedSelection: ExecutionRecallSelection;
  lines: string[];
}

export interface RecallReviewApplicationFormatters {
  formatAutoAppliedMemoryBlock(input: {
    taskId: string;
    taskTitle: string;
    preferenceCandidates: PreferenceMemoryCandidate[];
    taskCandidates: TaskMemoryCandidate[];
  }): string[];
  formatSuppressedRecallBlock(input: {
    taskId: string;
    taskTitle: string;
    preferenceCount: number;
    taskMemoryCount: number;
  }): string[];
}

export class RecallReviewApplicationService {
  constructor(
    private readonly deps: {
      memoryContextService: Pick<MemoryContextService, 'prepareRecallReviewContext' | 'buildAcceptedRecallSelection'>;
      recallPolicyService: Pick<RecallPolicyService, 'resolve'>;
      memoryCaptureService: Pick<MemoryCaptureService, 'auditMemory'>;
      formatters: RecallReviewApplicationFormatters;
    },
  ) {}

  async apply(input: RecallReviewApplicationInput): Promise<RecallReviewApplicationResult> {
    const recallContext = await this.deps.memoryContextService.prepareRecallReviewContext({
      taskId: input.taskId,
      userPrompt: input.userPrompt,
    });
    const {
      autoAppliedPreferenceCandidates,
      reviewPreferenceCandidates,
      autoAppliedTaskCandidates,
      reviewTaskCandidates,
    } = recallContext;

    const decision = this.deps.recallPolicyService.resolve({
      proposalType: input.proposalType,
      taskCandidates: reviewTaskCandidates,
      preferenceCandidates: reviewPreferenceCandidates,
    });
    const policyApplied = !decision.requiresReview || input.proposalType !== null;
    const acceptedPreferenceCandidates = policyApplied
      ? [...autoAppliedPreferenceCandidates, ...reviewPreferenceCandidates]
      : autoAppliedPreferenceCandidates;
    const acceptedTaskCandidates = policyApplied
      ? [...autoAppliedTaskCandidates, ...reviewTaskCandidates]
      : autoAppliedTaskCandidates;

    const lines: string[] = [];
    if (acceptedPreferenceCandidates.length > 0 || acceptedTaskCandidates.length > 0) {
      this.auditAutoAppliedPreferenceCandidates(input.taskId, acceptedPreferenceCandidates);
      lines.push(...this.deps.formatters.formatAutoAppliedMemoryBlock({
        taskId: input.taskId,
        taskTitle: input.taskTitle,
        preferenceCandidates: acceptedPreferenceCandidates,
        taskCandidates: acceptedTaskCandidates,
      }));
    }

    const skippedPreferenceCandidates = policyApplied ? [] : reviewPreferenceCandidates;
    const skippedTaskCandidates = policyApplied ? [] : reviewTaskCandidates;
    if (skippedPreferenceCandidates.length > 0 || skippedTaskCandidates.length > 0) {
      this.auditSuppressedPreferenceCandidates(input.taskId, skippedPreferenceCandidates);
      lines.push(...this.deps.formatters.formatSuppressedRecallBlock({
        taskId: input.taskId,
        taskTitle: input.taskTitle,
        preferenceCount: skippedPreferenceCandidates.length,
        taskMemoryCount: skippedTaskCandidates.length,
      }));
    }

    return {
      approvedSelection: this.deps.memoryContextService.buildAcceptedRecallSelection(
        acceptedPreferenceCandidates,
        acceptedTaskCandidates,
      ),
      lines,
    };
  }

  private auditAutoAppliedPreferenceCandidates(taskId: string, candidates: PreferenceMemoryCandidate[]): void {
    for (const candidate of candidates) {
      const score = candidate.applicabilityScore ?? Math.min(1, candidate.score / 100);
      const reason = candidate.applicabilityReason ?? candidate.reason;
      this.deps.memoryCaptureService.auditMemory({
        taskId,
        memoryId: candidate.preferenceId,
        action: 'auto_apply',
        score,
        reason,
        judgeSource: candidate.judgeSource ?? 'rule',
        evidence: [{ reason: candidate.reason, source: candidate.source }],
      });
    }
  }

  private auditSuppressedPreferenceCandidates(taskId: string, candidates: PreferenceMemoryCandidate[]): void {
    for (const candidate of candidates) {
      this.deps.memoryCaptureService.auditMemory({
        taskId,
        memoryId: candidate.preferenceId,
        action: 'suppress',
        score: candidate.applicabilityScore ?? Math.min(1, candidate.score / 100),
        reason: `不确定是否适用，默认不召回：${candidate.applicabilityReason ?? candidate.reason}`,
        judgeSource: candidate.judgeSource ?? 'rule',
        evidence: [{ reason: candidate.reason, source: candidate.source }],
      });
    }
  }
}
