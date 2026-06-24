import type { MemoryEngine } from './memory-engine.js';
import type { NotificationService } from '../notifications/types.js';
import { MemoryAuditEventRepo } from '../storage/memory-audit-event-repo.js';
import { generateInteractionId } from '../utils/id.js';
import type Database from 'better-sqlite3';
import { VerificationAndDeliveryService } from './verification-and-delivery-service.js';
import {
  extractHighConfidencePreferenceCandidates,
  extractPatterns,
  isHighRiskMemoryCandidate,
} from '../session/session-helpers.js';

export interface MemoryCaptureResult {
  lines: string[];
}

export class MemoryCaptureService {
  private readonly auditRepo: MemoryAuditEventRepo;

  constructor(
    private readonly deps: {
      db: Database.Database;
      memoryEngine: MemoryEngine;
      notifier: NotificationService;
      deliveryService: Pick<VerificationAndDeliveryService, 'deliverMemoryCandidate'>;
    },
  ) {
    this.auditRepo = new MemoryAuditEventRepo(deps.db);
  }

  captureExplicitPreference(input: string): MemoryCaptureResult {
    const pref = this.deps.memoryEngine.addManual({
      content: input,
      scope: 'global',
      type: 'domain',
    });
    return { lines: [`已记住偏好 #${pref.id}: ${pref.content}`] };
  }

  captureHighConfidencePreferences(input: string, sourceId: string): MemoryCaptureResult {
    const candidates = extractHighConfidencePreferenceCandidates(input);
    if (candidates.length === 0) {
      return { lines: [] };
    }

    const lines: string[] = [];
    for (const candidate of candidates) {
      this.captureHighConfidenceCandidate(candidate, sourceId, lines);
    }

    return {
      lines: lines.length > 0
        ? lines
        : ['→ 这条偏好已在候选或已确认记忆中，无需重复记录'],
    };
  }

  captureCompletionPatterns(input: {
    userPrompt: string;
    output: string;
    taskId: string;
  }): MemoryCaptureResult {
    const lines: string[] = [];
    for (const pattern of extractPatterns(input.userPrompt)) {
      const { observation, shouldPromptConfirm } = this.deps.memoryEngine.observe(pattern, input.taskId);
      if (!shouldPromptConfirm) {
        continue;
      }

      lines.push(
        '',
        `💡 检测到重复模式（${observation.occurrenceCount}次）："${pattern}"`,
        `   已保留为候选，不等待确认；如需保存，可稍后用 /memory confirm ${observation.id} 手动确认`,
      );
      this.deps.deliveryService.deliverMemoryCandidate(this.deps.notifier, {
        observationId: observation.id,
        pattern,
        source: 'repeated-pattern',
      });
    }

    lines.push(...this.captureHighConfidencePreferences(input.output, input.taskId).lines.filter(line =>
      line !== '→ 这条偏好已在候选或已确认记忆中，无需重复记录'
    ));
    return { lines };
  }

  private captureHighConfidenceCandidate(candidate: string, sourceId: string, lines: string[]): void {
    if (
      !sourceId.startsWith('task_')
      && !isHighRiskMemoryCandidate(candidate)
      && !this.hasExistingPreference(candidate)
    ) {
      const pref = this.deps.memoryEngine.addManual({
        content: candidate,
        scope: 'global',
        type: 'domain',
      });
      this.auditMemory({
        taskId: null,
        memoryId: pref.id,
        action: 'auto_capture',
        score: 1,
        reason: '用户明确长期偏好，低风险自动写入',
        judgeSource: 'rule',
        evidence: [{ sourceId, content: candidate }],
      });
      lines.push(`→ 已自动记录偏好 #${pref.id}: ${pref.content}`);
      return;
    }

    const { observation, shouldPromptConfirm } = this.deps.memoryEngine.observeCandidate(candidate, sourceId);
    if (!shouldPromptConfirm) {
      return;
    }

    if (isHighRiskMemoryCandidate(candidate)) {
      lines.push(
        '',
        `⚠️ 高风险偏好不会静默写入："${candidate}"`,
        `   已保留为候选，不等待确认；如需保存，可稍后用 /memory confirm ${observation.id} 手动确认`,
      );
    } else {
      lines.push(
        '',
        `💡 检测到可能的长期偏好："${candidate}"`,
        `   已保留为候选，不等待确认；如需保存，可稍后用 /memory confirm ${observation.id} 手动确认`,
      );
    }
    this.deps.deliveryService.deliverMemoryCandidate(this.deps.notifier, {
      observationId: observation.id,
      pattern: candidate,
      source: 'high-confidence',
    });
  }

  private hasExistingPreference(content: string): boolean {
    return this.deps.memoryEngine.list().some(preference => preference.content === content);
  }

  auditMemory(input: {
    taskId: string | null;
    memoryId: string;
    action: 'auto_capture' | 'auto_apply' | 'ask_review' | 'suppress';
    score: number | null;
    reason: string;
    judgeSource: string;
    evidence: unknown[];
  }): void {
    this.auditRepo.insert({
      id: `memory_audit_${generateInteractionId()}`,
      taskId: input.taskId,
      memoryId: input.memoryId,
      action: input.action,
      score: input.score,
      reason: input.reason,
      judgeSource: input.judgeSource,
      evidence: input.evidence,
      createdAt: new Date().toISOString(),
    });
  }
}
