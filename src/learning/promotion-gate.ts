import type { LearningCandidateKind, LearningCandidateSafetyStatus, LearningCandidateStatus } from '../storage/learning-candidate-repo.js';

export type PromotionDecision = 'needs_review' | 'promote' | 'blocked' | 'rejected';

export interface PromotionGateInput {
  kind: LearningCandidateKind;
  status: LearningCandidateStatus;
  safetyStatus: LearningCandidateSafetyStatus;
}

export interface PromotionGateResult {
  decision: PromotionDecision;
  reason: string;
}

export class PromotionGate {
  evaluate(input: PromotionGateInput): PromotionGateResult {
    if (input.safetyStatus === 'blocked') {
      return { decision: 'blocked', reason: 'Safety scanner blocked this candidate.' };
    }

    if (input.status === 'rejected') {
      return { decision: 'rejected', reason: 'Candidate was rejected during review.' };
    }

    if (input.status === 'approved') {
      return { decision: 'promote', reason: 'Candidate was approved and passed safety checks.' };
    }

    return { decision: 'needs_review', reason: 'Candidate must be reviewed by the user before promotion.' };
  }
}
