import type { Task } from './types.js';

export type NaturalLanguageRoute = 'conversation' | 'task_control' | 'durable_task';

const TASK_CONTROL_PATTERNS = [
  /继续之前挂起的任务/,
  /把之前挂起的任务继续完成/,
  /继续刚才那个任务/,
  /继续刚才的任务/,
  /恢复刚才/,
  /暂停刚才/,
  /挂起刚才/,
  /网络恢复了.*继续/,
  /网络好了.*继续/,
];

const CONVERSATION_PATTERNS = [
  /^hi$/i,
  /^hello$/i,
  /^hey$/i,
  /^你好$/,
  /^在吗$/,
  /^收到$/,
  /^ok$/i,
  /^好的$/,
  /^请只回复[:：]/,
  /^退出$/,
  /你以后就是我的大管家/,
  /你的名字叫/,
  /我是磊哥/,
  /记住了吗/,
  /刚才咱们聊了啥/,
  /刚才咱们跑了什么任务/,
  /刚才让你做了一个.*还记得/,
  /我们之前是不是做了一个/,
  /你说的是哪个项目/,
  /我们进行到哪里了/,
  /你还记得不/,
  /你还记得我/,
  /hi，刚才/,
];

const DURABLE_WORK_PATTERNS = [
  /调研/,
  /分析/,
  /方案/,
  /报告/,
  /结论/,
  /整理/,
  /对比/,
  /一页/,
  /市场份额/,
  /基本面/,
  /股价/,
  /产品/,
  /项目/,
  /新能源/,
  /memory/i,
  /agent/i,
  /search engine/i,
];

export function classifyNaturalLanguageInput(input: string, tasks: Task[]): NaturalLanguageRoute {
  if (isTaskControlInstruction(input) && hasManageableTask(tasks)) {
    return 'task_control';
  }

  if (isConversationInput(input)) {
    return 'conversation';
  }

  return 'durable_task';
}

export function isTaskControlInstruction(input: string): boolean {
  const normalized = input.trim();
  return TASK_CONTROL_PATTERNS.some(pattern => pattern.test(normalized));
}

export function isConversationInput(input: string): boolean {
  const normalized = input.trim();
  return CONVERSATION_PATTERNS.some(pattern => pattern.test(normalized));
}

export function isDurableTask(task: Task): boolean {
  if (!['done', 'cancelled', 'archived'].includes(task.status)) {
    return true;
  }

  if (
    task.resources.length > 0
    || task.snapshots.length > 0
    || task.dependencies.length > 0
    || task.interruptionCount > 0
  ) {
    return true;
  }

  const sample = `${task.title}\n${task.goal}`.trim();
  if (isTaskControlInstruction(sample) || isConversationInput(sample)) {
    return false;
  }

  return DURABLE_WORK_PATTERNS.some(pattern => pattern.test(sample)) || sample.length >= 8;
}

export function filterDurableTasks(tasks: Task[]): Task[] {
  return tasks.filter(task => isDurableTask(task));
}

function hasManageableTask(tasks: Task[]): boolean {
  return tasks.some(task => ['created', 'ready', 'running', 'parked', 'blocked'].includes(task.status));
}
