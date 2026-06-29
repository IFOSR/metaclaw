import type { Task, TaskStatus } from '../core/types.js';

export type TaskExecutionPlan =
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

export function planTaskExecution(task: Task, userPrompt: string): TaskExecutionPlan {
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
