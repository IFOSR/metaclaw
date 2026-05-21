import {
  MemoryApplicabilityAction,
  MemoryApplicabilityJudgeSource,
  type MemoryApplicabilityAction as MemoryApplicabilityActionType,
  type MemoryApplicabilityJudgeSource as MemoryApplicabilityJudgeSourceType,
  type Preference,
  type PreferenceMemoryCandidate,
  type PreferenceScope,
  type PreferenceStatus,
  type Observation,
  type TaskMemoryCandidate,
} from './types.js';
import type { PreferenceRepo } from '../storage/preference-repo.js';
import type { ObservationRepo } from '../storage/observation-repo.js';
import type { TaskMemoryCardRepo } from '../storage/task-memory-card-repo.js';
import type { PreferenceEmbeddingService } from './preference-embedding-service.js';
import type { HybridMemoryRecaller, HybridMemoryRecallResult } from './hybrid-memory-recaller.js';
import type { PreferenceRecallDecision } from './llm-bridge.js';
import { generatePreferenceId } from '../utils/id.js';

const CONFIRM_THRESHOLD = 3;

export interface RecallContext {
  taskId?: string;
  keywords: string[];
  subject?: string;
  topK?: number;
  userInput?: string;
}

interface ScoredPreference {
  pref: Preference;
  score: number;
}

interface PreferenceRecallJudge {
  recallPreferences(userInput: string, candidates: Array<{
    id: string;
    scope: string;
    subject: string | null;
    type: string;
    content: string;
  }>): Promise<PreferenceRecallDecision[]>;
}

type PersonalityTone = 'playful' | 'casual' | 'warm' | 'formal' | 'sharp' | 'generic';

const SCOPE_PRIORITY: Record<string, number> = {
  'task-local': 40,
  contact: 30,
  project: 20,
  global: 10,
};

const SCOPE_TRI_STATE_THRESHOLDS: Record<PreferenceScope, { autoApply: number; askReview: number }> = {
  'task-local': { autoApply: 0.72, askReview: 0.45 },
  project: { autoApply: 0.8, askReview: 0.55 },
  contact: { autoApply: 0.82, askReview: 0.58 },
  global: { autoApply: 0.88, askReview: 0.65 },
};

export class MemoryEngine {
  constructor(
    private prefRepo: PreferenceRepo,
    private obsRepo: ObservationRepo,
    private preferenceEmbeddingService?: PreferenceEmbeddingService,
    private hybridMemoryRecaller?: Pick<HybridMemoryRecaller, 'recall'>,
    private taskMemoryCardRepo?: Pick<TaskMemoryCardRepo, 'searchRelevant'>,
    private preferenceRecallJudge?: PreferenceRecallJudge,
  ) {}

  /**
   * 观察记录：从交互中提取模式
   */
  observe(pattern: string, taskId: string): {
    observation: Observation;
    shouldPromptConfirm: boolean;
  } {
    const observation = this.obsRepo.upsert(pattern, taskId);
    return {
      observation,
      shouldPromptConfirm: observation.occurrenceCount >= CONFIRM_THRESHOLD
        && !observation.promotedToPreferenceId,
    };
  }

  observeCandidate(pattern: string, taskId: string): {
    observation: Observation;
    shouldPromptConfirm: boolean;
  } {
    const observation = this.obsRepo.upsertCandidate(pattern, taskId);
    return {
      observation,
      shouldPromptConfirm: !observation.promotedToPreferenceId,
    };
  }

  /**
   * 用户确认偏好
   */
  confirm(observationId: string, scope: PreferenceScope, subject?: string): Preference {
    // 查找观察记录（通过遍历 candidates）
    const candidates = this.obsRepo.findCandidates();
    const obs = candidates.find(c => c.id === observationId);
    if (!obs) throw new Error(`观察记录不存在或未达到确认阈值: ${observationId}`);

    const now = new Date().toISOString();
    const pref: Preference = {
      id: generatePreferenceId(),
      type: this.inferType(obs.pattern, subject),
      scope,
      subject: subject || null,
      content: obs.pattern,
      status: 'confirmed',
      confidence: 0.9,
      occurrenceCount: obs.occurrenceCount,
      sourceTasks: obs.sourceTasks,
      lastUsedAt: null,
      confirmedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.prefRepo.insert(pref);
    this.obsRepo.markPromoted(observationId, pref.id);
    this.refreshEmbedding(pref);
    return pref;
  }

  /**
   * 用户拒绝候选偏好
   */
  reject(observationId: string): void {
    // 标记为已处理（promoted_to = 'rejected'）
    this.obsRepo.markPromoted(observationId, 'rejected');
  }

  /**
   * 用户手动添加偏好（跳过三次确认）
   */
  addManual(input: {
    content: string;
    scope: PreferenceScope;
    type: string;
    subject?: string;
  }): Preference {
    const now = new Date().toISOString();
    const pref: Preference = {
      id: generatePreferenceId(),
      type: input.type,
      scope: input.scope,
      subject: input.subject || null,
      content: input.content,
      status: 'confirmed',
      confidence: 1.0,
      occurrenceCount: 1,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.prefRepo.insert(pref);
    this.refreshEmbedding(pref);
    return pref;
  }

  /**
   * 偏好召回：根据当前上下文返回相关偏好
   */
  recall(context: RecallContext): Preference[] {
    const results: ScoredPreference[] = [];
    const seen = new Set<string>();
    const userInput = context.userInput ?? '';
    const communicationCue = /(邮件|发信|发给|回复|消息|沟通|通知)/.test(userInput);
    const projectCue = /(项目|术语|周报|方案|里程碑|复盘|材料)/.test(userInput);

    for (const preference of this.prefRepo.findAll()) {
      if (preference.status !== 'confirmed') continue;

      if (
        preference.scope === 'task-local'
        && context.taskId
        && (preference.subject === context.taskId || preference.sourceTasks.includes(context.taskId))
      ) {
        results.push({
          pref: preference,
          score: 1_000 + (SCOPE_PRIORITY[preference.scope] ?? 0),
        });
        seen.add(preference.id);
      }
    }

    // 1. 精确匹配 subject
    if (context.subject) {
      const exact = this.prefRepo.findBySubject(context.subject);
      for (const p of exact) {
        if (!seen.has(p.id)) {
          results.push({ pref: p, score: 200 + (SCOPE_PRIORITY[p.scope] ?? 0) });
          seen.add(p.id);
        }
      }
    }

    // 2.5 用户输入直接命中已有 subject，并按场景做 contact/project 裁决
    if (userInput) {
      for (const preference of this.prefRepo.findAll()) {
        if (preference.status !== 'confirmed' || !preference.subject || !userInput.includes(preference.subject)) {
          continue;
        }

        let score = 100 + (SCOPE_PRIORITY[preference.scope] ?? 0);
        if (preference.scope === 'contact' && communicationCue) {
          score += 300;
        } else if (preference.scope === 'project' && projectCue) {
          score += 300;
        } else if (preference.scope === 'contact') {
          score += 60;
        } else if (preference.scope === 'project') {
          score += 120;
        }

        if (seen.has(preference.id)) {
          const existing = results.find(result => result.pref.id === preference.id);
          if (existing) existing.score = Math.max(existing.score, score);
        } else {
          results.push({ pref: preference, score });
          seen.add(preference.id);
        }
      }
    }

    // 2.75 confirmed global 偏好只在当前场景显式相关时作为低优先级工作方式。
    // 不能把所有 global 偏好都默认候选，否则会在无关输入上反复弹出召回确认。
    for (const preference of this.prefRepo.findByScope('global')) {
      if (preference.status !== 'confirmed' || seen.has(preference.id)) {
        continue;
      }

      if (!this.isGlobalPreferenceSceneCompatible(preference, userInput)) {
        continue;
      }

      results.push({
        pref: preference,
        score: 5 + (SCOPE_PRIORITY[preference.scope] ?? 0),
      });
      seen.add(preference.id);
    }

    // 2. 关键词匹配 content
    for (const keyword of context.keywords) {
      const matched = this.prefRepo.searchByKeyword(keyword);
      for (const p of matched) {
        if (p.scope === 'global' && !this.isGlobalPreferenceSceneCompatible(p, [userInput, keyword].join(' '))) {
          continue;
        }

        if (seen.has(p.id)) {
          const existing = results.find(r => r.pref.id === p.id);
          if (existing) existing.score += 30;
        } else {
          results.push({ pref: p, score: 30 + (SCOPE_PRIORITY[p.scope] ?? 0) });
          seen.add(p.id);
        }
      }
    }

    // 3. 按作用域优先级排序
    results.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      const scopeDiff = (SCOPE_PRIORITY[b.pref.scope] ?? 0) - (SCOPE_PRIORITY[a.pref.scope] ?? 0);
      return scopeDiff;
    });

    // 4. Top-K 截取
    const topK = context.topK ?? 5;
    return results.slice(0, topK).map(r => r.pref);
  }

  async recallForReview(context: RecallContext): Promise<HybridMemoryRecallResult> {
    const queryText = context.userInput ?? [context.subject, ...context.keywords].filter(Boolean).join(' ');
    const rulePreferenceCandidates = await this.recallPreferencesForReview(context, queryText);
    const taskMemoryCardCandidates: TaskMemoryCandidate[] = this.taskMemoryCardRepo && context.taskId
      ? this.taskMemoryCardRepo.searchRelevant({
        queryText,
        currentTaskId: context.taskId,
        keywords: context.keywords,
        topK: context.topK,
      }).map(card => ({
        id: card.id,
        taskId: card.taskId,
        sourceTaskId: card.taskId,
        memoryKind: 'task_summary' as const,
        title: card.title,
        summary: card.summary,
        reason: card.reason,
        source: 'continuity' as const,
        score: card.score,
        artifactPaths: card.artifacts,
      }))
      : [];

    if (!this.hybridMemoryRecaller) {
      return {
        preferenceCandidates: rulePreferenceCandidates,
        taskCandidates: taskMemoryCardCandidates,
        auditId: null,
      };
    }

    return this.hybridMemoryRecaller.recall({
      taskId: context.taskId,
      queryText,
      keywords: context.keywords,
      subject: context.subject,
      topK: context.topK,
      rulePreferenceCandidates,
      ruleTaskCandidates: taskMemoryCardCandidates,
    });
  }

  private async recallPreferencesForReview(context: RecallContext, queryText: string) {
    const executorCandidates = this.buildExecutorPreferenceCandidates(context);

    if (this.preferenceRecallJudge && queryText.trim() && executorCandidates.length > 0) {
      try {
        const decisions = await this.preferenceRecallJudge.recallPreferences(
          queryText,
          executorCandidates.map(preference => ({
            id: preference.id,
            scope: preference.scope,
            subject: preference.subject,
            type: preference.type,
            content: preference.content,
          })),
        );
        const byId = new Map(executorCandidates.map(preference => [preference.id, preference]));
        return this.filterSuppressedCandidates(decisions
          .map(decision => {
            const preference = byId.get(decision.preferenceId);
            if (!preference) {
              return null;
            }

            return this.annotateApplicability(this.toPreferenceMemoryCandidate(
              preference,
              decision.reason,
              Math.round((decision.score ?? preference.confidence) * 100),
            ), {
              action: decision.action ?? this.resolveActionFromScore(preference.scope, decision.score ?? preference.confidence),
              score: decision.score ?? preference.confidence,
              reason: decision.reason,
              judgeSource: MemoryApplicabilityJudgeSource.LLM,
            });
          })
          .filter((candidate): candidate is PreferenceMemoryCandidate => Boolean(candidate)));
      } catch {
        // Executor semantic matching is the preferred path. If unavailable, fall back to legacy rules.
      }
    }

    return this.filterSuppressedCandidates(this.recall(context).map(preference => {
      const score = this.estimateFallbackApplicabilityScore(preference, context);
      const reason = this.buildRuleRecallReason(preference, context);
      return this.annotateApplicability(this.toPreferenceMemoryCandidate(
        preference,
        reason,
        Math.round(score * 100),
      ), {
        action: this.resolveActionFromScore(preference.scope, score),
        score,
        reason,
        judgeSource: MemoryApplicabilityJudgeSource.FALLBACK,
      });
    }));
  }

  private buildExecutorPreferenceCandidates(context: RecallContext): Preference[] {
    const candidates: Preference[] = [];
    const seen = new Set<string>();

    for (const preference of this.prefRepo.findAll()) {
      if (preference.status !== 'confirmed') {
        continue;
      }

      if (
        preference.scope === 'task-local'
        && context.taskId
        && !(preference.subject === context.taskId || preference.sourceTasks.includes(context.taskId))
      ) {
        continue;
      }

      if (context.subject && preference.subject && preference.subject !== context.subject) {
        // Keep global/task-local candidates broad, but avoid asking the executor to choose unrelated named entities.
        if (preference.scope === 'project' || preference.scope === 'contact') {
          continue;
        }
      }

      if (!seen.has(preference.id)) {
        seen.add(preference.id);
        candidates.push(preference);
      }
    }

    return candidates;
  }

  private toPreferenceMemoryCandidate(preference: Preference, reason: string, score: number) {
    return {
      id: preference.id,
      preferenceId: preference.id,
      scope: preference.scope,
      subject: preference.subject,
      summary: preference.content,
      reason,
      source: 'rule' as const,
      score,
    };
  }

  private annotateApplicability(
    candidate: PreferenceMemoryCandidate,
    decision: {
      action: MemoryApplicabilityActionType;
      score: number;
      reason: string;
      judgeSource: MemoryApplicabilityJudgeSourceType;
    },
  ): PreferenceMemoryCandidate {
    return {
      ...candidate,
      applicabilityAction: decision.action,
      applicabilityScore: Math.max(0, Math.min(1, decision.score)),
      applicabilityReason: decision.reason,
      judgeSource: decision.judgeSource,
    };
  }

  private filterSuppressedCandidates(candidates: PreferenceMemoryCandidate[]): PreferenceMemoryCandidate[] {
    return candidates.filter(candidate => candidate.applicabilityAction !== MemoryApplicabilityAction.SUPPRESS);
  }

  private resolveActionFromScore(scope: PreferenceScope, score: number): MemoryApplicabilityActionType {
    const threshold = SCOPE_TRI_STATE_THRESHOLDS[scope];
    if (score >= threshold.autoApply) {
      return MemoryApplicabilityAction.AUTO_APPLY;
    }
    if (score >= threshold.askReview) {
      return MemoryApplicabilityAction.ASK_REVIEW;
    }
    return MemoryApplicabilityAction.SUPPRESS;
  }

  private estimateFallbackApplicabilityScore(preference: Preference, context: RecallContext): number {
    if (
      preference.scope === 'task-local'
      && context.taskId
      && (preference.subject === context.taskId || preference.sourceTasks.includes(context.taskId))
    ) {
      return Math.max(preference.confidence, 0.92);
    }

    if (context.subject && preference.subject === context.subject) {
      const threshold = SCOPE_TRI_STATE_THRESHOLDS[preference.scope];
      return Math.max(0, Math.min(threshold.autoApply - 0.01, preference.confidence));
    }

    const threshold = SCOPE_TRI_STATE_THRESHOLDS[preference.scope];
    return Math.max(0, Math.min(threshold.autoApply - 0.01, preference.confidence * 0.8));
  }

  private buildRuleRecallReason(preference: Preference, context: RecallContext): string {
    if (
      preference.scope === 'task-local'
      && context.taskId
      && (preference.subject === context.taskId || preference.sourceTasks.includes(context.taskId))
    ) {
      return '命中当前任务局部偏好';
    }

    if (preference.subject) {
      return `命中主体：${preference.subject}`;
    }

    if (preference.scope === 'global' && preference.type === 'style') {
      return this.isPersonalityTonePreference(preference.content)
        ? '匹配当前场合后采用该表达风格'
        : '命中通用表达偏好';
    }

    return 'fallback 关键词/规则召回';
  }

  /**
   * 偏好 CRUD
   */
  update(prefId: string, changes: Partial<Preference>): Preference {
    this.prefRepo.update(prefId, changes);
    const updated = this.prefRepo.findById(prefId)!;
    this.refreshEmbedding(updated);
    return updated;
  }

  recordUsage(prefId: string, taskId: string): Preference {
    this.prefRepo.recordUsage(prefId, taskId);
    return this.prefRepo.findById(prefId)!;
  }

  delete(prefId: string): void {
    this.prefRepo.delete(prefId);
  }

  list(filter?: { scope?: PreferenceScope; status?: PreferenceStatus }): Preference[] {
    if (filter?.scope) return this.prefRepo.findByScope(filter.scope);
    if (filter?.status) return this.prefRepo.findByStatus(filter.status);
    return this.prefRepo.findAll();
  }

  getCandidates(): Observation[] {
    return this.obsRepo.findCandidates();
  }

  /**
   * 推断偏好类型
   */
  private inferType(pattern: string, subject?: string): string {
    if (subject) return 'contact';
    if (/格式|风格|语气|语言/.test(pattern)) return 'style';
    if (/流程|步骤|方式/.test(pattern)) return 'workflow';
    return 'domain';
  }

  private refreshEmbedding(preference: Preference): void {
    if (!this.preferenceEmbeddingService) {
      return;
    }

    void this.preferenceEmbeddingService.embedPreference(preference).catch(() => {
      // Embedding is an optional enhancement layer and must not block memory flows.
    });
  }

  private isGlobalPreferenceSceneCompatible(preference: Preference, userInput: string): boolean {
    if (preference.scope !== 'global') {
      return true;
    }

    const normalizedInput = userInput.replace(/\s+/g, '');
    if (!normalizedInput) {
      return false;
    }

    const preferenceTone = this.classifyPersonalityTonePreference(preference.content);
    if (preferenceTone) {
      return this.isPersonalityToneSceneCompatible(preferenceTone, userInput);
    }

    return this.extractGlobalPreferenceTriggerTerms(preference.content)
      .some(term => normalizedInput.includes(term));
  }

  private isPersonalityTonePreference(content: string): boolean {
    return this.classifyPersonalityTonePreference(content) !== null;
  }

  private classifyPersonalityTonePreference(content: string): PersonalityTone | null {
    const normalized = content.replace(/\s+/g, '');
    if (/(活泼|欢快|幽默|俏皮)/.test(normalized)) {
      return 'playful';
    }
    if (/(轻松|口语化|随意|聊天感|像搭子)/.test(normalized)) {
      return 'casual';
    }
    if (/(亲切|热情|温暖|鼓励|陪伴感)/.test(normalized)) {
      return 'warm';
    }
    if (/(严肃|正式|严谨|克制|专业|稳重)/.test(normalized)) {
      return 'formal';
    }
    if (/(犀利|毒舌|尖锐|锐利)/.test(normalized)) {
      return 'sharp';
    }
    if (/(语气|风格|口吻|语调)/.test(normalized)) {
      return 'generic';
    }
    return null;
  }

  private isPersonalityToneSceneCompatible(preferenceTone: PersonalityTone, userInput: string): boolean {
    const normalized = userInput.replace(/\s+/g, '');
    if (!normalized) {
      return false;
    }

    const requestedTones = this.detectRequestedPersonalityTones(normalized);
    if (requestedTones.size > 0) {
      return requestedTones.has(preferenceTone) || (preferenceTone === 'generic' && requestedTones.size > 0);
    }

    if (this.isStructuredWorkScene(normalized)) {
      return preferenceTone === 'formal';
    }

    if (/(邮件|发信|发给|回复|消息|沟通|通知)/.test(normalized)) {
      return preferenceTone !== 'sharp';
    }

    if (/(文案|宣传|推文|帖子|小红书|朋友圈|口播|脚本|slogan|标题|开场白|欢迎词|广告|海报|宣传语|简介)/i.test(normalized)) {
      return ['playful', 'casual', 'warm', 'generic'].includes(preferenceTone);
    }

    return false;
  }

  private detectRequestedPersonalityTones(normalizedInput: string): Set<PersonalityTone> {
    const tones = new Set<PersonalityTone>();
    if (/(活泼|欢快|幽默|俏皮)/.test(normalizedInput)) tones.add('playful');
    if (/(轻松|口语化|随意|聊天感|像搭子)/.test(normalizedInput)) tones.add('casual');
    if (/(亲切|热情|温暖|鼓励|陪伴感)/.test(normalizedInput)) tones.add('warm');
    if (/(严肃|正式|严谨|克制|专业|稳重)/.test(normalizedInput)) tones.add('formal');
    if (/(犀利|毒舌|尖锐|锐利)/.test(normalizedInput)) tones.add('sharp');
    return tones;
  }

  private isStructuredWorkScene(normalizedInput: string): boolean {
    return /(ppt|幻灯片|slides|报告|周报|纪要|总结|提纲|方案|一页|表格|文档|材料|复盘|汇报|调研|分析|研究|投资|估值|财务|市场|竞争|尽调)/i.test(normalizedInput);
  }

  private extractGlobalPreferenceTriggerTerms(content: string): string[] {
    const normalized = content.replace(/\s+/g, '');
    const stopTerms = new Set([
      '以后', '之后', '后续', '凡是', '让你', '相关', '内容', '详细', '展示',
      '默认', '应该', '需要', '必须', '都要', '同步', '形成', '生成', '创建',
      '输出', '使用', '采用', '进行', '这个', '那个', '当前', '全部',
      '强制', '不要', '不强', '制表',
    ]);
    const terms = new Set<string>();

    for (const term of normalized.match(/[A-Za-z][A-Za-z0-9_-]{1,}|[\u4e00-\u9fff]{2,}/g) ?? []) {
      if (!stopTerms.has(term)) {
        terms.add(term);
      }
    }

    const chars = [...normalized];
    for (let index = 0; index <= chars.length - 2; index += 1) {
      const bigram = chars[index] + chars[index + 1];
      if (/^[\u4e00-\u9fff]{2}$/u.test(bigram) && !stopTerms.has(bigram)) {
        terms.add(bigram);
      }
    }

    return Array.from(terms)
      .filter(term => term.length >= 2)
      .filter(term => !this.isNegatedGlobalPreferenceTerm(normalized, term));
  }

  private isNegatedGlobalPreferenceTerm(normalizedContent: string, term: string): boolean {
    const index = normalizedContent.indexOf(term);
    if (index < 0) {
      return false;
    }

    const prefix = normalizedContent.slice(Math.max(0, index - 4), index);
    return /(不强制|不要|不需要|无需|避免)$/.test(prefix);
  }
}
