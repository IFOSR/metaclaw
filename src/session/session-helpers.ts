import type { Task, TaskStatus } from '../core/types.js';
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, resolve } from 'path';

export type ExecutionPlan =
  | {
      mode: 'reuse-existing';
      executionTaskId: string;
      contextTaskId: string;
      transitions: TaskStatus[];
    }
  | {
      mode: 'fork-follow-up';
      contextTaskId: string;
      transitions: TaskStatus[];
      newTaskInput: {
        title: string;
        goal: string;
        resources: string[];
      };
    }
  | {
      mode: 'blocked';
      error: string;
    };

export type QueuedExecutionRequest = {
  userPrompt: string;
  contextTaskId: string;
  executionMode: 'fresh' | 'resume-parked' | 'resume-blocked' | 'follow-up';
  schedulingReason?: string;
  priorityHint?: 'normal' | 'high' | 'urgent';
  newlyProvidedResources?: string[];
};

export function extractPatterns(input: string): string[] {
  const patterns: string[] = [];

  const styleMatch = input.match(/用(.{2,10})(格式|语气|方式|风格)/);
  if (styleMatch) patterns.push(`用${styleMatch[1]}${styleMatch[2]}`);

  const ccMatch = input.match(/抄送(.{2,10})/);
  if (ccMatch) patterns.push(`抄送${ccMatch[1]}`);

  return patterns;
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

export interface InlineResourceMatch {
  raw: string;
  resolvedPath: string;
}

export function extractInlineResourceMatches(input: string, cwd = process.cwd()): InlineResourceMatch[] {
  const matches: InlineResourceMatch[] = [];
  const seen = new Set<string>();
  const quotedPattern = /(["'])(.+?)\1/g;

  for (const match of input.matchAll(quotedPattern)) {
    const raw = match[2]?.trim();
    if (!raw) {
      continue;
    }
    maybePushInlineResource(raw, raw, cwd, seen, matches);
  }

  const tokens = input.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const cleaned = token.replace(/^[,，。！？；：（）()\[\]{}"']+|[,，。！？；：（）()\[\]{}"']+$/g, '');
    if (!cleaned) {
      continue;
    }
    maybePushInlineResource(cleaned, cleaned, cwd, seen, matches);
  }

  return matches;
}

export function stripInlineResourceMatches(input: string, matches: InlineResourceMatch[]): string {
  let cleaned = input;
  for (const match of matches) {
    cleaned = cleaned.replace(match.raw, ' ');
  }

  return cleaned
    .replace(/\s+(和|以及)\s+/g, ' ')
    .replace(/^(基于|根据|结合)\s+(整理|分析|输出|生成|总结|撰写|提炼|归纳|制作)/, '$2')
    .replace(/\s+/g, ' ')
    .replace(/\s*([，。,.;；：！？])/g, '$1')
    .trim();
}

function maybePushInlineResource(
  raw: string,
  candidate: string,
  cwd: string,
  seen: Set<string>,
  matches: InlineResourceMatch[],
): void {
  if (looksLikeUrl(candidate)) {
    if (seen.has(candidate)) {
      return;
    }

    seen.add(candidate);
    matches.push({ raw, resolvedPath: candidate });
    return;
  }

  if (!looksLikeLocalPath(candidate)) {
    return;
  }

  const resolvedPath = resolveInlinePath(candidate, cwd);
  if (!resolvedPath || seen.has(resolvedPath)) {
    return;
  }

  try {
    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
      return;
    }
  } catch {
    return;
  }

  seen.add(resolvedPath);
  matches.push({ raw, resolvedPath });
}

function looksLikeLocalPath(candidate: string): boolean {
  return candidate.startsWith('/')
    || candidate.startsWith('./')
    || candidate.startsWith('../')
    || candidate.startsWith('~/')
    || candidate.includes('/')
    || /^[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8}$/.test(candidate);
}

function looksLikeUrl(candidate: string): boolean {
  return /^https?:\/\/\S+$/i.test(candidate);
}

function resolveInlinePath(candidate: string, cwd: string): string | null {
  if (candidate.startsWith('~/')) {
    return resolve(homedir(), candidate.slice(2));
  }

  if (isAbsolute(candidate)) {
    return candidate;
  }

  return resolve(cwd, candidate);
}

export function isResumeReferenceInstruction(input: string): boolean {
  return /挂起|恢复|继续之前|继续刚才|接着刚才|继续完成/.test(input);
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

export function planTaskExecution(task: Task, userPrompt: string): ExecutionPlan {
  switch (task.status) {
    case 'created':
      return {
        mode: 'reuse-existing',
        executionTaskId: task.id,
        contextTaskId: task.id,
        transitions: ['ready', 'running'],
      };
    case 'ready':
      return {
        mode: 'reuse-existing',
        executionTaskId: task.id,
        contextTaskId: task.id,
        transitions: ['running'],
      };
    case 'parked':
      return {
        mode: 'reuse-existing',
        executionTaskId: task.id,
        contextTaskId: task.id,
        transitions: ['ready', 'running'],
      };
    case 'running':
      return {
        mode: 'reuse-existing',
        executionTaskId: task.id,
        contextTaskId: task.id,
        transitions: [],
      };
    case 'blocked':
      return {
        mode: 'blocked',
        error: '当前任务已阻塞，请先解除阻塞再继续。',
      };
    case 'done':
    case 'archived':
    case 'cancelled':
      return {
        mode: 'fork-follow-up',
        contextTaskId: task.id,
        transitions: ['ready', 'running'],
        newTaskInput: {
          title: userPrompt.slice(0, 50),
          goal: userPrompt,
          resources: task.resources,
        },
      };
  }
}
