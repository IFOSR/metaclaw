import type Database from 'better-sqlite3';
import { SkillGovernanceEngine } from './skill-governance-engine.js';
import { LearningCandidateRepo, type LearningCandidateKind } from '../storage/learning-candidate-repo.js';
import { SkillEffectSummaryRepo } from '../storage/skill-effect-summary-repo.js';
import { TaskMemoryCardRepo } from '../storage/task-memory-card-repo.js';

export interface LearningWeeklyReviewOptions {
  now?: string;
  since?: string;
  candidateLimit?: number;
  cardLimit?: number;
  skillLimit?: number;
}

export interface WeeklyCandidateItem {
  id: string;
  kind: LearningCandidateKind;
  title: string;
  safetyStatus: string;
  createdAt: string;
}

export interface WeeklyTaskMemoryCardItem {
  taskId: string;
  title: string;
  outcome: string;
  summary: string;
  updatedAt: string;
}

export interface WeeklySkillGovernanceItem {
  id: string;
  kind: 'skill_deprecation' | 'skill_disable';
  title: string;
  content: string;
}

export interface LearningWeeklyReview {
  title: string;
  since: string;
  now: string;
  pendingCandidates: WeeklyCandidateItem[];
  recentTaskMemoryCards: WeeklyTaskMemoryCardItem[];
  skillGovernanceRecommendations: WeeklySkillGovernanceItem[];
  markdown: string;
  pendingCandidateCount: number;
  taskMemoryCardCount: number;
  governanceRecommendationCount: number;
}

function isoDate(value: string): string {
  return value.slice(0, 10);
}

function defaultSince(now: string): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - 7);
  return date.toISOString();
}

function formatAssetIdFromGovernanceContent(content: string): string {
  const executor = content.match(/executor：([^\n]+)/)?.[1]?.trim() ?? 'unknown-executor';
  const skill = content.match(/skill：([^\n]+)/)?.[1]?.trim() ?? 'unknown-skill';
  const version = content.match(/version：([^\n]+)/)?.[1]?.trim();
  return `${executor}/${skill}${version ? `@${version}` : ''}`;
}

function formatCandidateKind(kind: LearningCandidateKind): string {
  const labels: Record<LearningCandidateKind, string> = {
    skill: 'Skill',
    skill_patch: 'Skill Patch',
    preference: 'Preference',
    workflow: 'Workflow',
    antipattern: 'Antipattern',
    verification_recipe: 'Verification Recipe',
    task_memory_card: 'Task Memory Card',
    skill_deprecation: 'Skill Deprecation',
    skill_disable: 'Skill Disable',
    safety_rule: 'Safety Rule',
  };
  return labels[kind];
}

export class LearningWeeklyReviewBuilder {
  constructor(private readonly db: Database.Database) {}

  build(options: LearningWeeklyReviewOptions = {}): LearningWeeklyReview {
    const now = options.now ?? new Date().toISOString();
    const since = options.since ?? defaultSince(now);
    const pendingCandidates = new LearningCandidateRepo(this.db)
      .listPending()
      .filter(candidate => candidate.createdAt >= since && candidate.createdAt <= now)
      .slice(0, options.candidateLimit ?? 20)
      .map(candidate => ({
        id: candidate.id,
        kind: candidate.kind,
        title: candidate.title,
        safetyStatus: candidate.safetyStatus,
        createdAt: candidate.createdAt,
      }));

    const recentTaskMemoryCards = new TaskMemoryCardRepo(this.db)
      .listRecent(options.cardLimit ?? 10)
      .filter(card => card.updatedAt >= since && card.updatedAt <= now)
      .map(card => ({
        taskId: card.taskId,
        title: card.title,
        outcome: card.outcome,
        summary: card.summary,
        updatedAt: card.updatedAt,
      }));

    const skillSummaries = new SkillEffectSummaryRepo(this.db).listTop(options.skillLimit ?? 20);
    const skillGovernanceRecommendations = new SkillGovernanceEngine()
      .review(skillSummaries)
      .map(candidate => ({
        id: candidate.id,
        kind: candidate.kind as 'skill_deprecation' | 'skill_disable',
        title: candidate.title,
        content: candidate.content,
      }));

    const title = `MetaClaw 学习周报 ${isoDate(since)} ~ ${isoDate(now)}`;
    const review: Omit<LearningWeeklyReview, 'markdown'> = {
      title,
      since,
      now,
      pendingCandidates,
      recentTaskMemoryCards,
      skillGovernanceRecommendations,
      pendingCandidateCount: pendingCandidates.length,
      taskMemoryCardCount: recentTaskMemoryCards.length,
      governanceRecommendationCount: skillGovernanceRecommendations.length,
    };

    return {
      ...review,
      markdown: this.renderMarkdown(review),
    };
  }

  private renderMarkdown(review: Omit<LearningWeeklyReview, 'markdown'>): string {
    const lines = [
      `# ${review.title}`,
      '',
      '## 总览',
      `- 待审核学习候选：${review.pendingCandidateCount}`,
      `- 最近任务记忆卡：${review.taskMemoryCardCount}`,
      `- Skill 治理建议：${review.governanceRecommendationCount}`,
      '',
      '## 待审核学习候选',
    ];

    if (review.pendingCandidates.length === 0) {
      lines.push('- 暂无待审核候选');
    } else {
      for (const candidate of review.pendingCandidates) {
        lines.push(
          `- ${candidate.title}（${formatCandidateKind(candidate.kind)}，安全：${candidate.safetyStatus}，ID：${candidate.id}）`,
          `  - approve：/learning approve ${candidate.id}`,
          `  - reject：/learning reject ${candidate.id}`,
        );
      }
    }

    lines.push('', '## 最近任务记忆卡');
    if (review.recentTaskMemoryCards.length === 0) {
      lines.push('- 暂无任务记忆卡');
    } else {
      for (const card of review.recentTaskMemoryCards) {
        lines.push(`- #${card.taskId} ${card.title}（${card.outcome}）：${card.summary}`);
      }
    }

    lines.push('', '## Skill 治理建议');
    if (review.skillGovernanceRecommendations.length === 0) {
      lines.push('- 暂无高风险 Skill 治理建议');
    } else {
      for (const recommendation of review.skillGovernanceRecommendations) {
        lines.push(
          `- ${recommendation.title}（${formatAssetIdFromGovernanceContent(recommendation.content)}）`,
          `  - 类型：${recommendation.kind}`,
          '  - 处理：生成 candidate 后仍需 approve/promote，不会自动禁用 Skill',
        );
      }
    }

    return lines.join('\n');
  }
}
