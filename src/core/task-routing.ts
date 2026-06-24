import type { Task, TaskStatus } from './types.js';

export type NaturalLanguageRoute = 'conversation' | 'metaclaw_status' | 'task_control' | 'durable_task';
export type NaturalLanguageRouteAction = NaturalLanguageRoute | 'ask_clarification' | 'unknown';
export type TaskClearScope = 'all' | 'parked' | 'blocked';
export type TaskStatusQueryScope = 'blocked' | 'running' | 'dashboard';
export type TaskStateOwner = 'metaclaw' | 'executor' | 'none';

export interface TaskStateOwnershipResult {
  owner: TaskStateOwner;
  scope: TaskStatusQueryScope | null;
  taskId: string | null;
  confidence: number;
  reason: string;
}

export const MANAGEABLE_TASK_STATUSES: TaskStatus[] = ['created', 'ready', 'running', 'parked', 'blocked'];

export const DURABLE_WORK_PATTERNS = [
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
  /实现/,
  /修复/,
  /review/i,
  /test/i,
  /memory/i,
  /agent/i,
  /search engine/i,
];

export function matchesDurableWorkPattern(input: string): boolean {
  return DURABLE_WORK_PATTERNS.some(pattern => pattern.test(input));
}

export function isTaskControlInstruction(input: string): boolean {
  const normalized = input.trim();
  return parseTaskClearInstruction(normalized) !== null
    || /继续之前挂起的任务|把之前挂起的任务继续完成|继续刚才那个任务|继续刚才的任务|恢复刚才|暂停刚才|挂起刚才|网络恢复了.*继续|网络好了.*继续/.test(normalized);
}

export function parseTaskClearInstruction(input: string): TaskClearScope | null {
  const normalized = input.replace(/\s+/g, '');
  if (!normalized) {
    return null;
  }

  const hasClearVerb = /(清空|清除|清理|全部取消|取消全部|取消所有|删除全部|删除所有)/.test(normalized);
  if (!hasClearVerb || !/(任务|task|tasks)/i.test(normalized)) {
    return null;
  }

  if (/(挂起|暂停|parked)/i.test(normalized)) {
    return 'parked';
  }

  if (/(阻塞|blocked)/i.test(normalized)) {
    return 'blocked';
  }

  if (/(所有|全部|全部的|所有的|all|active|可执行|待执行|进行中|当前)/i.test(normalized)) {
    return 'all';
  }

  return null;
}

export function parseTaskStatusQuery(input: string): TaskStatusQueryScope | null {
  const normalized = input.replace(/\s+/g, '');
  if (!normalized) {
    return null;
  }

  const asksAboutTasks = /(任务|task|tasks|队列|状态|进度|盘面|阻塞|blocked|挂起|parked|执行|完成|结果|卡住|卡在哪里)/i.test(normalized);
  if (!asksAboutTasks) {
    return null;
  }

  const isQuery = /(有没有|是否有|有哪些|查看|检查|列出|显示|看一下|看下|多少|几个|状态|进度|盘面|清单|列表|了吗|什么|哪里|当前|正在|还没有|没收到)/.test(normalized);
  if (!isQuery) {
    return null;
  }

  if (/(阻塞|blocked)/i.test(normalized)) {
    return 'blocked';
  }

  if (/(正在执行|当前执行|执行什么|什么任务|完成了吗|是否完成|有没有完成|没收到结果|没有收到结果|卡在哪里|卡住|running)/i.test(normalized)) {
    return 'running';
  }

  if (/(任务状态|任务进度|任务盘面|任务清单|任务列表|队列|当前任务|所有任务|有哪些任务|有什么任务)/i.test(normalized)) {
    return 'dashboard';
  }

  return null;
}

export function isConversationInput(input: string): boolean {
  return /^(hi|hello|hey|你好|在吗|收到|ok|好的)$/i.test(input.trim());
}

export function isDurableTask(task: Task): boolean {
  if (['created', 'ready', 'running', 'parked', 'blocked'].includes(task.status)) {
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

  return matchesDurableWorkPattern(sample) || sample.length >= 8;
}

export function filterDurableTasks(tasks: Task[]): Task[] {
  return tasks.filter(task => isDurableTask(task));
}
