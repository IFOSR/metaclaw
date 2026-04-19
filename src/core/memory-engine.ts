import type { Preference, PreferenceScope, PreferenceStatus, Observation } from './types.js';
import type { PreferenceRepo } from '../storage/preference-repo.js';
import type { ObservationRepo } from '../storage/observation-repo.js';
import { generatePreferenceId } from '../utils/id.js';

const CONFIRM_THRESHOLD = 3;

interface RecallContext {
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

  /**
   * 偏好 CRUD
   */
  update(prefId: string, changes: Partial<Preference>): Preference {
    this.prefRepo.update(prefId, changes);
    return this.prefRepo.findById(prefId)!;
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
}
