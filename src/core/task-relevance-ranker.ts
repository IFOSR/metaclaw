import type { Task } from './types.js';

export type TaskRelevanceRecommendation = 'inject' | 'review' | 'more' | 'reject';

export interface TaskRelevanceRankInput {
  currentTask: Task;
  userInput: string;
  keywords: string[];
  candidates: Task[];
  now?: Date;
}

export interface TaskRelevanceScore {
  taskId: string;
  finalScore: number;
  lexicalScore: number;
  semanticScore: number;
  entityScore: number;
  intentScore: number;
  recencyScore: number;
  statusScore: number;
  artifactScore: number;
  negativeScore: number;
  reason: string;
  riskFlags: string[];
  recommendation: TaskRelevanceRecommendation;
}

const GENERIC_TERMS = new Set([
  '问题',
  '任务',
  '之前',
  '继续',
  '优化',
  '修复',
  '怎么',
  '方案',
  '参考',
  '历史',
]);

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function includesTerm(text: string, term: string): boolean {
  return normalize(text).includes(normalize(term));
}

function tokenize(text: string): string[] {
  const normalized = normalize(text);
  const rawTokens = normalized
    .split(/[^\w\u4e00-\u9fff-]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2);

  const tokens: string[] = [];
  for (const token of rawTokens) {
    if (!GENERIC_TERMS.has(token)) {
      tokens.push(token);
    }
    if (/^[\u4e00-\u9fff]+$/.test(token) && token.length >= 2) {
      for (let index = 0; index <= token.length - 2; index += 1) {
        const bigram = token.slice(index, index + 2);
        if (!GENERIC_TERMS.has(bigram)) {
          tokens.push(bigram);
        }
      }
    }
  }

  return unique(tokens);
}

function taskText(task: Task): string {
  return [
    task.title,
    task.goal,
    task.summary,
    ...task.resources,
    ...task.artifacts,
    ...task.snapshots.flatMap(snapshot => [
      ...snapshot.done,
      ...snapshot.pending,
      snapshot.nextStep,
      snapshot.pauseReason,
    ]),
  ].filter(Boolean).join('\n');
}

function scoreOverlap(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  const matched = left.filter(token => rightSet.has(token)).length;
  return clampScore((matched / Math.max(1, left.length)) * 100);
}

function inferEntities(text: string, explicitKeywords: string[]): string[] {
  const keywordEntities = explicitKeywords
    .map(keyword => keyword.trim())
    .filter(keyword => keyword.length >= 2 && !GENERIC_TERMS.has(keyword));
  const latinOrNumber = text.match(/[A-Za-z][A-Za-z0-9_-]{1,}|\d{2,}/g) ?? [];
  const chineseNamedChunks = text.match(/[\u4e00-\u9fff]{2,}(?:项目|周报|起诉书|材料|栏目|平台|任务|方案)/g) ?? [];
  return unique([...keywordEntities, ...latinOrNumber, ...chineseNamedChunks]);
}

function recencyScore(candidate: Task, now: Date): number {
  const updated = new Date(candidate.updatedAt || candidate.createdAt).getTime();
  if (Number.isNaN(updated)) {
    return 20;
  }
  const ageDays = Math.max(0, (now.getTime() - updated) / 86_400_000);
  if (ageDays <= 14) return 100;
  if (ageDays <= 45) return 75;
  if (ageDays <= 90) return 45;
  return 20;
}

function statusScore(candidate: Task): number {
  if (candidate.status === 'done') return 100;
  if (candidate.status === 'ready') return 75;
  if (candidate.status === 'running' || candidate.status === 'parked') return 60;
  if (candidate.status === 'blocked') return 25;
  if (candidate.status === 'cancelled') return 0;
  return 50;
}

function buildRecommendation(score: number): TaskRelevanceRecommendation {
  if (score >= 80) return 'inject';
  if (score >= 65) return 'review';
  if (score >= 50) return 'more';
  return 'reject';
}

export class TaskRelevanceRanker {
  rank(input: TaskRelevanceRankInput): TaskRelevanceScore[] {
    const now = input.now ?? new Date();
    const currentText = [taskText(input.currentTask), input.userInput, input.keywords.join(' ')].join('\n');
    const currentTokens = unique([...tokenize(currentText), ...input.keywords.map(keyword => normalize(keyword)).filter(Boolean)]);
    const currentEntities = inferEntities(currentText, input.keywords);
    const explicitReference = /(?:任务|task|#)\s*[_#-]?[a-z0-9_-]+/i.test(input.userInput);

    return input.candidates
      .map(candidate => this.scoreCandidate(candidate, currentTokens, currentEntities, input, now, explicitReference))
      .filter((score): score is TaskRelevanceScore => score !== null && score.recommendation !== 'reject')
      .sort((left, right) => right.finalScore - left.finalScore || left.taskId.localeCompare(right.taskId));
  }

  private scoreCandidate(
    candidate: Task,
    currentTokens: string[],
    currentEntities: string[],
    input: TaskRelevanceRankInput,
    now: Date,
    explicitReference: boolean,
  ): TaskRelevanceScore | null {
    if (candidate.id === input.currentTask.id) {
      return null;
    }

    const candidateText = taskText(candidate);
    const candidateTokens = tokenize(candidateText);
    const sharedKeywords = input.keywords
      .filter(keyword => keyword.length >= 2 && !GENERIC_TERMS.has(keyword))
      .filter(keyword => includesTerm(candidateText, keyword));
    const sharedEntities = currentEntities.filter(entity => includesTerm(candidateText, entity));
    const lexicalScore = Math.max(scoreOverlap(input.keywords.map(normalize), candidateTokens), scoreOverlap(currentTokens, candidateTokens));
    const entityScore = currentEntities.length === 0 ? 0 : clampScore((sharedEntities.length / currentEntities.length) * 100);
    const semanticScore = clampScore((lexicalScore * 0.65) + (entityScore * 0.35));
    const intentScore = this.intentScore(input.currentTask, input.userInput, candidate);
    const candidateRecencyScore = recencyScore(candidate, now);
    const candidateStatusScore = statusScore(candidate);
    const artifactScore = candidate.artifacts.length > 0 ? 100 : candidate.resources.length > 0 ? 65 : 0;
    const riskFlags: string[] = [];
    const reasons: string[] = [];

    if (sharedKeywords.length > 0) {
      reasons.push(`共享关键词：${unique(sharedKeywords).join('、')}`);
    }
    if (sharedEntities.length > 0) {
      reasons.push(`共享实体：${unique(sharedEntities).slice(0, 3).join('、')}`);
    }
    if (artifactScore >= 100) {
      reasons.push('存在可参考产物');
    }
    if (intentScore >= 70) {
      reasons.push('任务意图相近');
    }

    if (artifactScore === 0) {
      riskFlags.push('no_artifacts');
    }
    if (candidateRecencyScore < 50) {
      riskFlags.push('stale_candidate');
    }
    if (candidate.status === 'blocked' || candidate.status === 'cancelled') {
      riskFlags.push(`status_${candidate.status}`);
    }
    if (intentScore < 45 && sharedEntities.length > 0) {
      riskFlags.push('intent_mismatch');
    }

    const negativeScore = riskFlags.reduce((sum, flag) => {
      if (flag === 'no_artifacts') return sum + 2;
      if (flag === 'stale_candidate') return sum + 5;
      if (flag === 'intent_mismatch') return sum + 4;
      if (flag.startsWith('status_')) return sum + 20;
      return sum + 3;
    }, 0);

    const hasMeaningfulOverlap = sharedKeywords.length > 0 || sharedEntities.length > 0 || lexicalScore >= 35;
    if (!hasMeaningfulOverlap) {
      return null;
    }
    if (!explicitReference && (candidate.status === 'blocked' || candidate.status === 'cancelled') && candidateStatusScore < 50) {
      return null;
    }
    if (reasons.length === 0) {
      return null;
    }

    const finalScore = clampScore(
      0.25 * semanticScore
      + 0.20 * lexicalScore
      + 0.20 * entityScore
      + 0.15 * intentScore
      + 0.10 * artifactScore
      + 0.05 * candidateStatusScore
      + 0.05 * candidateRecencyScore
      - negativeScore,
    );
    const boostedScore = this.applyContinuityFloors(finalScore, {
      sharedKeywordsCount: sharedKeywords.length,
      sharedEntitiesCount: sharedEntities.length,
      artifactScore,
      candidateStatusScore,
      userInput: input.userInput,
      riskFlags,
    });
    const recommendation = buildRecommendation(boostedScore);
    if (recommendation === 'reject') {
      return null;
    }

    return {
      taskId: candidate.id,
      finalScore: boostedScore,
      lexicalScore,
      semanticScore,
      entityScore,
      intentScore,
      recencyScore: candidateRecencyScore,
      statusScore: candidateStatusScore,
      artifactScore,
      negativeScore,
      reason: reasons.join('；'),
      riskFlags,
      recommendation,
    };
  }

  private applyContinuityFloors(
    score: number,
    context: {
      sharedKeywordsCount: number;
      sharedEntitiesCount: number;
      artifactScore: number;
      candidateStatusScore: number;
      userInput: string;
      riskFlags: string[];
    },
  ): number {
    let adjusted = score;
    const asksForReference = /复用|沿用|参考|上次|历史/.test(context.userInput);

    if (
      context.sharedKeywordsCount >= 3
      && context.artifactScore >= 100
      && context.candidateStatusScore >= 75
      && context.riskFlags.length === 0
    ) {
      adjusted = Math.max(adjusted, 82);
    }

    if (
      asksForReference
      && context.sharedEntitiesCount > 0
      && context.riskFlags.includes('no_artifacts')
      && context.riskFlags.includes('stale_candidate')
    ) {
      adjusted = Math.max(adjusted, 68);
      adjusted = Math.min(adjusted, 79);
    }

    return clampScore(adjusted);
  }

  private intentScore(currentTask: Task, userInput: string, candidate: Task): number {
    const currentIntentTokens = tokenize([currentTask.title, currentTask.goal, userInput].join('\n'));
    const candidateIntentTokens = tokenize([candidate.title, candidate.goal, candidate.summary].join('\n'));
    return scoreOverlap(currentIntentTokens, candidateIntentTokens);
  }
}
