import {
  RecallReviewOption,
  type PreferenceMemoryCandidate,
  type RecallReviewCard,
  type TaskMemoryCandidate,
} from '../core/types.js';

export interface RecallReviewBuildInput {
  taskCandidates: TaskMemoryCandidate[];
  preferenceCandidates: PreferenceMemoryCandidate[];
  maxTaskItems?: number;
  maxPreferenceItems?: number;
}

const DEFAULT_MAX_TASK_ITEMS = 3;
const DEFAULT_MAX_PREFERENCE_ITEMS = 3;

export class RecallReviewBuilder {
  build(input: RecallReviewBuildInput): RecallReviewCard {
    const taskMemorySummary = this.pickTopTaskCandidates(
      input.taskCandidates,
      input.maxTaskItems ?? DEFAULT_MAX_TASK_ITEMS,
    ).map(candidate => ({
      label: this.cleanText(candidate.title),
      summary: this.buildTaskSummary(candidate),
      reason: this.cleanText(candidate.reason),
    }));

    const preferenceMemorySummary = this.pickTopPreferenceCandidates(
      input.preferenceCandidates,
      input.maxPreferenceItems ?? DEFAULT_MAX_PREFERENCE_ITEMS,
    ).map(candidate => ({
      scope: candidate.scope,
      summary: this.cleanText(candidate.summary),
      reason: this.cleanText(candidate.reason),
    }));

    return {
      taskMemorySummary,
      preferenceMemorySummary,
      options: [
        RecallReviewOption.ACCEPT_ALL,
        RecallReviewOption.REJECT_ALL,
        RecallReviewOption.SELECT_PARTIAL,
        RecallReviewOption.EDIT,
        RecallReviewOption.AUTO_APPLY_FUTURE,
      ],
    };
  }

  private pickTopTaskCandidates(candidates: TaskMemoryCandidate[], limit: number): TaskMemoryCandidate[] {
    return this.dedupeById(candidates)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.title.localeCompare(right.title, 'zh-Hans-CN');
      })
      .slice(0, limit);
  }

  private pickTopPreferenceCandidates(
    candidates: PreferenceMemoryCandidate[],
    limit: number,
  ): PreferenceMemoryCandidate[] {
    return this.dedupeById(candidates)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.summary.localeCompare(right.summary, 'zh-Hans-CN');
      })
      .slice(0, limit);
  }

  private dedupeById<T extends { id: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    const result: T[] = [];

    for (const item of items) {
      if (seen.has(item.id)) {
        continue;
      }

      seen.add(item.id);
      result.push(item);
    }

    return result;
  }

  private buildTaskSummary(candidate: TaskMemoryCandidate): string {
    const summary = this.cleanText(candidate.summary);
    const reason = this.cleanText(candidate.reason);
    const prefix = reason.includes('恢复型召回')
      ? '恢复型召回：'
      : reason.includes('参考型召回')
        ? '参考型召回：'
        : '';
    const base = `${prefix}${summary}`;
    if (candidate.artifactPaths.length === 0) {
      return base;
    }

    return `${base}可复用附件 ${candidate.artifactPaths.length} 份。`;
  }

  private cleanText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }
}
