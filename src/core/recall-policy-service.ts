import { PreferenceScope, RecallReviewPolicyType, type GuidanceActionType, type PreferenceMemoryCandidate, type RecallReviewPolicy, type TaskMemoryCandidate } from './types.js';
import type { RecallReviewPolicyLookup, RecallReviewPolicyRepo } from '../storage/recall-review-policy-repo.js';

export interface RecallPolicyResolveInput {
  proposalType: GuidanceActionType | null;
  taskCandidates: TaskMemoryCandidate[];
  preferenceCandidates: PreferenceMemoryCandidate[];
}

export interface RecallPolicyDecision {
  requiresReview: boolean;
  autoApply: boolean;
  matchedPolicies: RecallReviewPolicy[];
  uncoveredCategories: string[];
}

export class RecallPolicyService {
  constructor(private policyRepo: Pick<RecallReviewPolicyRepo, 'findMatching'>) {}

  resolve(input: RecallPolicyResolveInput): RecallPolicyDecision {
    const proposalPolicy = input.proposalType
      ? this.findAutoApplyPolicy([
          {
            policyType: RecallReviewPolicyType.PROPOSAL_TYPE,
            scope: null,
            subject: null,
            proposalType: input.proposalType,
          },
        ])
      : null;

    if (proposalPolicy) {
      return {
        requiresReview: false,
        autoApply: true,
        matchedPolicies: [proposalPolicy],
        uncoveredCategories: [],
      };
    }

    const matchedPolicies: RecallReviewPolicy[] = [];
    const uncoveredCategories: string[] = [];

    if (input.taskCandidates.length > 0) {
      const taskMemoryPolicy = this.findAutoApplyPolicy([
        {
          policyType: RecallReviewPolicyType.TASK_MEMORY,
          scope: null,
          subject: null,
          proposalType: input.proposalType,
        },
        {
          policyType: RecallReviewPolicyType.TASK_MEMORY,
          scope: null,
          subject: null,
          proposalType: null,
        },
      ]);

      if (taskMemoryPolicy) {
        matchedPolicies.push(taskMemoryPolicy);
      } else {
        uncoveredCategories.push('task_memory');
      }
    }

    for (const subject of this.getUniqueSubjects(input.preferenceCandidates, PreferenceScope.PROJECT)) {
      const policy = this.findAutoApplyPolicy([
        {
          policyType: RecallReviewPolicyType.PROJECT_PREFERENCE,
          scope: PreferenceScope.PROJECT,
          subject,
          proposalType: input.proposalType,
        },
        {
          policyType: RecallReviewPolicyType.PROJECT_PREFERENCE,
          scope: PreferenceScope.PROJECT,
          subject,
          proposalType: null,
        },
      ]);

      if (policy) {
        matchedPolicies.push(policy);
      } else {
        uncoveredCategories.push(`project:${subject}`);
      }
    }

    for (const subject of this.getUniqueSubjects(input.preferenceCandidates, PreferenceScope.CONTACT)) {
      const policy = this.findAutoApplyPolicy([
        {
          policyType: RecallReviewPolicyType.CONTACT_PREFERENCE,
          scope: PreferenceScope.CONTACT,
          subject,
          proposalType: input.proposalType,
        },
        {
          policyType: RecallReviewPolicyType.CONTACT_PREFERENCE,
          scope: PreferenceScope.CONTACT,
          subject,
          proposalType: null,
        },
      ]);

      if (policy) {
        matchedPolicies.push(policy);
      } else {
        uncoveredCategories.push(`contact:${subject}`);
      }
    }

    for (const category of this.getUnsupportedPreferenceCategories(input.preferenceCandidates)) {
      uncoveredCategories.push(category);
    }

    return {
      requiresReview: uncoveredCategories.length > 0,
      autoApply: uncoveredCategories.length === 0,
      matchedPolicies,
      uncoveredCategories,
    };
  }

  private findAutoApplyPolicy(lookups: RecallReviewPolicyLookup[]): RecallReviewPolicy | null {
    for (const lookup of lookups) {
      const policy = this.policyRepo.findMatching(lookup);
      if (policy?.autoApply) {
        return policy;
      }
    }

    return null;
  }

  private getUniqueSubjects(
    candidates: PreferenceMemoryCandidate[],
    scope: PreferenceMemoryCandidate['scope'],
  ): string[] {
    const subjects = new Set<string>();

    for (const candidate of candidates) {
      if (candidate.scope !== scope || !candidate.subject) {
        continue;
      }

      subjects.add(candidate.subject);
    }

    return Array.from(subjects).sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
  }

  private getUnsupportedPreferenceCategories(candidates: PreferenceMemoryCandidate[]): string[] {
    const categories = new Set<string>();

    for (const candidate of candidates) {
      if (candidate.scope === PreferenceScope.PROJECT || candidate.scope === PreferenceScope.CONTACT) {
        continue;
      }

      if (candidate.subject) {
        categories.add(`${candidate.scope}:${candidate.subject}`);
        continue;
      }

      categories.add(candidate.scope);
    }

    return Array.from(categories).sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
  }
}
