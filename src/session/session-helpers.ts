import type { TaskRecoveryTrigger } from '../core/types.js';
import type { IntentDecision } from '../core/executor-router.js';
import type { IntentDecisionV2 } from '../core/intent-orchestrator.js';
export { planTaskExecution, type TaskExecutionPlan as ExecutionPlan } from '../core/task-execution-planner.js';
export {
  extractInlineResourceMatches,
  stripInlineResourceMatches,
  type InlineResourceMatch,
} from '../intent/inline-resource-normalizer.js';

export type QueuedExecutionRequest = {
  userPrompt: string;
  contextTaskId: string;
  executionMode: 'fresh' | 'resume-parked' | 'resume-blocked' | 'follow-up';
  intentDecision?: IntentDecisionV2 | null;
  semanticExecutorDecision?: IntentDecision | null;
  origin?: 'user' | 'system';
  schedulingReason?: string;
  newlyProvidedResources?: string[];
  recoveryTrigger?: TaskRecoveryTrigger;
  includeRecentConversationContext?: boolean;
};

export function extractPatterns(input: string): string[] {
  const patterns: string[] = [];

  const styleMatch = input.match(/用(.{2,10})(格式|语气|方式|风格)/);
  if (styleMatch) patterns.push(`用${styleMatch[1]}${styleMatch[2]}`);

  const ccMatch = input.match(/抄送(.{2,10})/);
  if (ccMatch) patterns.push(`抄送${ccMatch[1]}`);

  return patterns;
}

export function extractHighConfidencePreferenceCandidates(input: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (candidate: string | undefined) => {
    const cleaned = cleanPreferenceCandidate(candidate);
    if (!cleaned || seen.has(cleaned)) {
      return;
    }
    seen.add(cleaned);
    candidates.push(cleaned);
  };

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const explicitBoldPreference = line.match(/(?:你|我)?明确偏好[：:]\s*\*\*(.+?)\*\*/);
    pushCandidate(explicitBoldPreference?.[1]);

    const reusableBoldRule = line.match(/(?:可复用的工作规则|固定成一条可复用的工作规则|工作规则)[：:]\s*\*\*(.+?)\*\*/);
    pushCandidate(reusableBoldRule?.[1]);

    const explicitPreference = line.match(/^(?:我)?(?:明确)?偏好[：:]\s*(.+)$/);
    pushCandidate(explicitPreference?.[1]);

    const futureRule = line.match(/^(?:以后|之后|后续|接下来)[，,。.\s]*(凡是.+)$/);
    pushCandidate(futureRule?.[1]);

    const defaultRule = line.match(/^(凡是.+(?:默认|应该|需要|必须).+)$/);
    pushCandidate(defaultRule?.[1]);

    const preferenceRule = line.match(/^(我(?:更喜欢|比较喜欢|希望|倾向于).+)$/);
    pushCandidate(preferenceRule?.[1]);
  }

  return candidates;
}

function cleanPreferenceCandidate(candidate: string | undefined): string | null {
  if (!candidate) {
    return null;
  }

  const cleaned = candidate
    .replace(/\*\*/g, '')
    .replace(/^["“”'「」]+|["“”'「」]+$/g, '')
    .replace(/[。；;，,]+$/g, '')
    .trim();

  if (cleaned.length < 8) {
    return null;
  }

  return cleaned;
}

export function parseExplicitRemember(input: string): string | null {
  const rememberMatch = input.match(/记住[：:]\s*(.+)/);
  return rememberMatch ? rememberMatch[1].trim() : null;
}

export function isRiskyExternalActionInstruction(input: string): boolean {
  const normalized = input.replace(/\s+/g, '');
  if (!normalized) {
    return false;
  }

  // 写草稿、润色、整理内容仍属于低风险准备动作，不进入外发确认门控。
  if (/(草稿|草拟|起草|写一封|写封|写个|撰写|整理|润色|修改|拟一封|生成)/.test(normalized)) {
    return false;
  }

  return /(发给客户|发给用户|发给对方|发送给客户|发送给用户|发送给对方|提交给法务|提交给财务|法务提交|财务提交|对外发送|外发|群发|发出去)/.test(normalized);
}

export function isHighRiskMemoryCandidate(input: string): boolean {
  const normalized = input.replace(/\s+/g, '');
  if (!normalized) {
    return false;
  }

  return /(自动)?(发给客户|发给用户|发给对方|发送给客户|发送给用户|发送给对方|对外发送|外发|群发|发出去|提交给法务|提交给财务|删除|清空|覆盖|生产环境|线上|prod|财务承诺|法律承诺|合同承诺)/i.test(normalized);
}

export function isRiskConfirmationInstruction(input: string): boolean {
  return /^(确认执行|继续执行|确认)$/u.test(input.trim());
}

export function isRiskCancellationInstruction(input: string): boolean {
  return /^(取消执行|取消|不用了|算了)$/u.test(input.trim());
}

export function prepareEditorSubmission(editor: { text: string; cursor: number }): {
  userInput: string;
  nextEditor: { text: string; cursor: number };
} {
  return {
    userInput: editor.text.trim(),
    nextEditor: { text: '', cursor: 0 },
  };
}

export function parsePriorityHint(input: string): 'normal' | 'high' | 'urgent' {
  if (/紧急|立即|立刻|马上|优先处理/.test(input)) return 'urgent';
  if (/尽快|优先/.test(input)) return 'high';
  return 'normal';
}

export function buildSchedulingReason(input: string): string {
  const priorityHint = parsePriorityHint(input);
  if (priorityHint === 'urgent') {
    return '用户显式要求优先处理';
  }
  if (priorityHint === 'high') {
    return '用户要求尽快优先';
  }
  return '用户提交';
}

export function isResumeReferenceInstruction(input: string): boolean {
  return /挂起|恢复|继续之前|继续刚才|接着刚才|继续完成/.test(input);
}

export function isContinuePreviousTaskInstruction(input: string): boolean {
  return /继续之前的任务|继续之前任务|继续上一个任务|继续上次的任务|继续刚才的任务|继续刚才那个任务|接着上次|接着之前的任务|继续上一轮任务|继续上一个任务/.test(input.trim());
}

export function isConversationalContinuationInstruction(input: string): boolean {
  const normalized = input.trim();
  if (!normalized) return false;

  return /^(可以[，,\s]*)?(继续|展开|接着说|细讲|详细说说|具体讲讲|再说说|再展开一点|然后呢|还有呢)$/.test(normalized);
}

export function isConversationDerivedWorkInstruction(input: string): boolean {
  const normalized = input.trim();
  if (!normalized) return false;

  return (
    /((把|基于|根据).*(刚才|上面|上一篇|那段|这段|刚刚|前面).*(分析|内容|文章|回答|结论)?.*(整理|总结|归纳|改写|翻译|扩写|存档|保存|写到|写入|导出|提炼|做成))/.test(normalized)
    || /((刚才|上面|上一篇|那段|这段|刚刚|前面).*(分析|内容|文章|回答|结论).*(整理|总结|归纳|改写|翻译|扩写|存档|保存|写到|写入|导出|提炼|做成))/.test(normalized)
  );
}

export function isExplicitTaskControlReference(input: string): boolean {
  return /挂起|恢复|阻塞|解除阻塞|任务|继续刚才那个任务|继续之前挂起的任务|把之前挂起的任务继续完成|重试刚才/.test(input)
    || input.includes('/task');
}

export function isRecoverableBlockedResumeInstruction(input: string): boolean {
  return /恢复|继续|重试|网络恢复|网络好了|联网了|已授权|已经授权|授权好了|权限开了|权限好了|允许访问/.test(input);
}
