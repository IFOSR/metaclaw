import type { Task } from './types.js';
import { isRecoverableExecutorFailure } from '../executor/error-utils.js';
import { extractInlineResourceMatches, isRecoverableBlockedResumeInstruction } from '../session/session-helpers.js';

export interface BlockedTaskReconcileDecision {
  task: Task;
  reason: string;
  newlyProvidedResources: string[];
}

export function reconcileBlockedTasksFromInput(
  tasks: Task[],
  userInput: string,
  cwd = process.cwd(),
): BlockedTaskReconcileDecision | null {
  const blockedTasks = tasks.filter(task => task.status === 'blocked');
  if (blockedTasks.length === 0) {
    return null;
  }

  const decisions = blockedTasks
    .map(task => evaluateBlockedTask(task, userInput, cwd))
    .filter((decision): decision is BlockedTaskReconcileDecision => Boolean(decision));

  if (decisions.length !== 1) {
    return null;
  }

  return decisions[0];
}

function evaluateBlockedTask(task: Task, userInput: string, cwd: string): BlockedTaskReconcileDecision | null {
  const waitingDependencies = task.dependencies.filter(dependency => dependency.status === 'waiting');
  if (waitingDependencies.length === 0) {
    return null;
  }

  const text = userInput.trim();
  const inlineResources = extractInlineResourceMatches(text, cwd).map(match => match.resolvedPath);
  const mentionsTask = text.includes(task.id);
  const matchesTask = mentionsTask || hasMeaningfulOverlap(text, `${task.title} ${task.goal}`);
  const blockedReason = waitingDependencies.map(dependency => dependency.description).join('；');

  if (inlineResources.length > 0 && (matchesTask || blockedTasksLikelyNeedMaterial(blockedReason))) {
    return {
      task,
      reason: '检测到补充材料，阻塞条件可重新判断',
      newlyProvidedResources: inlineResources,
    };
  }

  if (isRecoverableExecutorFailure(blockedReason) && isRecoverableBlockedResumeInstruction(text) && matchesTask) {
    return {
      task,
      reason: '检测到可恢复故障已解除',
      newlyProvidedResources: [],
    };
  }

  if (isPermissionBlocked(blockedReason) && isPermissionResolvedInstruction(text) && matchesTask) {
    return {
      task,
      reason: '检测到权限或授权已确认',
      newlyProvidedResources: [],
    };
  }

  if (isMaterialSupplementInstruction(text) && matchesTask) {
    return {
      task,
      reason: '检测到用户补充了阻塞所需信息',
      newlyProvidedResources: inlineResources,
    };
  }

  return null;
}

function blockedTasksLikelyNeedMaterial(reason: string): boolean {
  return /材料|文件|链接|文档|资料|补充|缺少|等待/.test(reason);
}

function isPermissionBlocked(reason: string): boolean {
  return /权限|授权|访问|permission|authorized|access/i.test(reason);
}

function isPermissionResolvedInstruction(input: string): boolean {
  return /已授权|已经授权|授权好了|权限开了|权限好了|可以访问|允许访问|已确认权限/.test(input);
}

function isMaterialSupplementInstruction(input: string): boolean {
  return /补充|已经补|材料|文件|链接|文档|资料|信息|说明|已上传|上传了|给你/.test(input);
}

function hasMeaningfulOverlap(input: string, taskText: string): boolean {
  const normalizedInput = input.toLowerCase();
  const normalizedTaskText = taskText.toLowerCase();
  const tokens = Array.from(new Set(normalizedInput
    .split(/[\s，。？！、；：""''（）()[\]{}<>【】]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2)
    .filter(token => !COMMON_TOKENS.has(token))));

  if (tokens.length === 0) {
    return false;
  }

  return tokens.some(token => normalizedTaskText.includes(token));
}

const COMMON_TOKENS = new Set([
  '这个',
  '那个',
  '刚才',
  '继续',
  '任务',
  '可以',
  '已经',
  '一下',
  '处理',
  '执行',
  '恢复',
]);
