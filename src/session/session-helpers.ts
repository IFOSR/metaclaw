import type { Task, TaskStatus } from '../core/types.js';

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
