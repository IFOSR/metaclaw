import {
  matchesDurableWorkPattern,
  parseTaskClearInstruction,
  parseTaskStatusQuery,
  type TaskClearScope,
  type TaskStatusQueryScope,
} from './task-routing.js';
import {
  extractInlineResourceMatches,
  isContinuePreviousTaskInstruction,
  isConversationDerivedWorkInstruction,
  isConversationalContinuationInstruction,
  isRecoverableBlockedResumeInstruction,
  isRiskyExternalActionInstruction,
  parsePriorityHint,
} from '../session/session-helpers.js';

export type RuleHintSource = 'parser' | 'safety_guard' | 'heuristic';

export type RuleHintKind =
  | 'task_control'
  | 'durable_work'
  | 'status_query'
  | 'clear_tasks'
  | 'resume_task'
  | 'conversation_continuation'
  | 'risk_external_send'
  | 'priority'
  | 'resource_reference';

export interface RuleHint {
  source: RuleHintSource;
  kind: RuleHintKind;
  weight: number;
  reason: string;
  evidence: string;
}

const RESUME_HINT = /继续之前|继续刚才|恢复刚才|恢复之前|继续.*任务|resume/i;
const RECOVERY_RESOLVED_HINT = /网络恢复|网络好了|联网了|已授权|已经授权|授权好了|权限开了|权限好了|允许访问|可以访问|已确认权限/;
const BLOCKED_MATERIAL_SUPPLEMENT_HINT = /补充|已经补|材料|文件|链接|文档|资料|信息|说明|已上传|上传了|给你/;

function clampWeight(weight: number): number {
  return Math.max(0, Math.min(1, weight));
}

function hint(input: Omit<RuleHint, 'weight'> & { weight: number }): RuleHint {
  return {
    ...input,
    weight: clampWeight(input.weight),
  };
}

export class RuleHintsProvider {
  constructor(private cwd = process.cwd()) {}

  collect(userInput: string): RuleHint[] {
    const hints: RuleHint[] = [];
    const clearScope = parseTaskClearInstruction(userInput);
    if (clearScope) {
      hints.push(this.clearTasksHint(clearScope));
    }

    const statusScope = parseTaskStatusQuery(userInput);
    if (statusScope) {
      hints.push(this.statusQueryHint(statusScope));
    }

    if (
      (isRecoverableBlockedResumeInstruction(userInput) && RECOVERY_RESOLVED_HINT.test(userInput))
      || BLOCKED_MATERIAL_SUPPLEMENT_HINT.test(userInput)
    ) {
      hints.push(hint({
        source: 'heuristic',
        kind: 'resume_task',
        weight: 0.8,
        reason: 'recoverable blocked-task resume expression matched',
        evidence: 'recover_blocked',
      }));
    } else if (/task_[A-Za-z0-9_-]+/.test(userInput) && /重启|执行|恢复|继续|resume/i.test(userInput)) {
      hints.push(hint({
        source: 'parser',
        kind: 'resume_task',
        weight: 0.85,
        reason: 'explicit task id resume expression matched',
        evidence: userInput.match(/task_[A-Za-z0-9_-]+/)?.[0] ?? userInput,
      }));
    } else if (isContinuePreviousTaskInstruction(userInput)) {
      hints.push(hint({
        source: 'heuristic',
        kind: 'resume_task',
        weight: 0.8,
        reason: 'last-task continuation expression matched',
        evidence: 'last_task_continuation',
      }));
    } else if (RESUME_HINT.test(userInput) && !/生成|预览|继续把|继续写|继续输出/.test(userInput)) {
      hints.push(hint({
        source: 'heuristic',
        kind: 'resume_task',
        weight: 0.7,
        reason: 'legacy resume-task expression matched',
        evidence: userInput,
      }));
    }

    if (isConversationalContinuationInstruction(userInput)) {
      hints.push(hint({
        source: 'heuristic',
        kind: 'conversation_continuation',
        weight: 0.55,
        reason: 'legacy conversational-continuation expression matched',
        evidence: userInput,
      }));
    }

    const conversationDerivedWork = isConversationDerivedWorkInstruction(userInput);
    if (conversationDerivedWork || matchesDurableWorkPattern(userInput)) {
      hints.push(hint({
        source: 'heuristic',
        kind: 'durable_work',
        weight: 0.6,
        reason: conversationDerivedWork
          ? 'legacy conversation-derived durable-work expression matched'
          : 'legacy durable-work expression matched',
        evidence: userInput,
      }));
    }

    if (isRiskyExternalActionInstruction(userInput)) {
      hints.push(hint({
        source: 'safety_guard',
        kind: 'risk_external_send',
        weight: 1,
        reason: 'external-send safety guard matched',
        evidence: userInput,
      }));
    }

    const priority = parsePriorityHint(userInput);
    if (priority !== 'normal') {
      hints.push(hint({
        source: 'heuristic',
        kind: 'priority',
        weight: priority === 'urgent' ? 0.9 : 0.7,
        reason: 'legacy priority expression matched',
        evidence: priority,
      }));
    }

    for (const resource of extractInlineResourceMatches(userInput, this.cwd)) {
      hints.push(hint({
        source: 'heuristic',
        kind: 'resource_reference',
        weight: 0.8,
        reason: 'inline resource reference matched',
        evidence: resource.resolvedPath,
      }));
    }

    return hints;
  }

  private clearTasksHint(scope: TaskClearScope): RuleHint {
    return hint({
      source: 'parser',
      kind: 'clear_tasks',
      weight: 0.95,
      reason: 'explicit task clear parser matched',
      evidence: scope,
    });
  }

  private statusQueryHint(scope: TaskStatusQueryScope): RuleHint {
    return hint({
      source: 'heuristic',
      kind: 'status_query',
      weight: 0.75,
      reason: 'task status query expression matched',
      evidence: scope,
    });
  }
}
