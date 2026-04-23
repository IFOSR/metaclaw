import type { Preference, PreferenceScope, PreferenceStatus, Observation } from './types.js';
import type { PreferenceRepo } from '../storage/preference-repo.js';
import type { ObservationRepo } from '../storage/observation-repo.js';
import type { PreferenceEmbeddingService } from './preference-embedding-service.js';
import type { HybridMemoryRecaller, HybridMemoryRecallResult } from './hybrid-memory-recaller.js';
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

const SCOPE_PRIORITY: Record<string, number> = {
  'task-local': 40,
  contact: 30,
  project: 20,
  global: 10,
};

export class MemoryEngine {
  constructor(
    private prefRepo: PreferenceRepo,
    private obsRepo: ObservationRepo,
    private preferenceEmbeddingService?: PreferenceEmbeddingService,
    private hybridMemoryRecaller?: Pick<HybridMemoryRecaller, 'recall'>,
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

    // 2.75 confirmed global 偏好作为最低优先级默认工作方式兜底
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
    const rulePreferenceCandidates = this.recall(context).map(preference => ({
      id: preference.id,
      preferenceId: preference.id,
      scope: preference.scope,
      subject: preference.subject,
      summary: preference.content,
      reason: preference.scope === 'task-local' && context.taskId && (
        preference.subject === context.taskId || preference.sourceTasks.includes(context.taskId)
      )
        ? '命中当前任务局部偏好'
        : preference.subject
          ? `命中主体：${preference.subject}`
          : preference.scope === 'global' && preference.type === 'style'
            ? this.isPersonalityTonePreference(preference.content)
              ? '匹配当前场合后采用该表达风格'
              : '命中通用表达偏好'
            : '命中当前输入关键词',
      source: 'rule' as const,
      score: Math.round(preference.confidence * 100),
    }));

    if (!this.hybridMemoryRecaller) {
      return {
        preferenceCandidates: rulePreferenceCandidates,
        taskCandidates: [],
        auditId: null,
      };
    }

    return this.hybridMemoryRecaller.recall({
      taskId: context.taskId,
      queryText: context.userInput ?? [context.subject, ...context.keywords].filter(Boolean).join(' '),
      keywords: context.keywords,
      subject: context.subject,
      topK: context.topK,
      rulePreferenceCandidates,
      ruleTaskCandidates: [],
    });
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
    if (preference.scope !== 'global' || preference.type !== 'style') {
      return true;
    }

    if (!this.isPersonalityTonePreference(preference.content)) {
      return true;
    }

    return this.isPersonalityToneSceneCompatible(userInput);
  }

  private isPersonalityTonePreference(content: string): boolean {
    return /(活泼|幽默|俏皮|轻松|亲切|热情|温暖|严肃|正式|口语化|随意|克制|文艺|犀利|毒舌)/.test(content)
      || /(语气|风格|口吻|语调)/.test(content);
  }

  private isPersonalityToneSceneCompatible(userInput: string): boolean {
    const normalized = userInput.replace(/\s+/g, '');
    if (!normalized) {
      return false;
    }

    if (/(活泼|幽默|俏皮|轻松|亲切|热情|温暖|严肃|正式|口语化|随意|克制|文艺|犀利|毒舌|语气|风格|口吻|语调)/.test(normalized)) {
      return true;
    }

    if (/(文案|宣传|推文|帖子|小红书|朋友圈|口播|脚本|slogan|标题|开场白|欢迎词|广告|海报|宣传语|简介)/i.test(normalized)) {
      return true;
    }

    if (/(邮件|发信|发给|回复|消息|沟通|通知)/.test(normalized)) {
      return true;
    }

    if (/(ppt|幻灯片|slides|报告|周报|纪要|总结|提纲|方案|一页|表格|文档|材料|复盘|汇报|调研|分析|研究|投资|估值|财务|市场|竞争|尽调)/i.test(normalized)) {
      return false;
    }

    return false;
  }
}
