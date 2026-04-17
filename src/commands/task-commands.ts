import type { CommandHandler, CommandContext, CommandResult } from './router.js';
import { filterDurableTasks } from '../core/task-routing.js';

function formatTaskLine(task: {
  id: string;
  status: string;
  title: string;
  lastSchedulingReason: string;
  lastInterruptionReason: string;
  dependencies: Array<{ status: string; description: string }>;
}) {
  const lines = [`  #${task.id} [${task.status.toUpperCase()}] ${task.title}`];

  if (task.status === 'running' || task.status === 'ready') {
    lines.push(`    → 原因：${task.lastSchedulingReason || '等待调度'}`);
  } else if (task.status === 'parked') {
    lines.push(`    → 原因：${task.lastInterruptionReason || '等待恢复'}`);
  } else if (task.status === 'blocked') {
    lines.push(`    → 阻塞：${task.dependencies.find(dep => dep.status === 'waiting')?.description || '未知原因'}`);
  }

  return lines.join('\n');
}

export const tasksCommand: CommandHandler = {
  name: 'tasks',
  aliases: [],
  description: '查看任务列表',
  async execute(args, context) {
    const filter = args[0];
    const repo = context.taskEngine['taskRepo'];
    let tasks;

    if (filter === 'active') {
      tasks = filterDurableTasks(repo.findActive());
    } else if (filter === 'ready') {
      tasks = filterDurableTasks(repo.findByStatus('ready'));
    } else if (filter === 'parked') {
      tasks = filterDurableTasks(repo.findByStatus('parked'));
    } else if (filter === 'blocked') {
      tasks = filterDurableTasks(repo.findByStatus('blocked'));
    } else if (filter === 'done') {
      tasks = filterDurableTasks(repo.findByStatus('done'));
    } else {
      tasks = filterDurableTasks(repo.findAll());
    }

    if (tasks.length === 0) {
      return { type: 'text', content: '暂无任务' };
    }

    if (filter) {
      const lines = tasks.map(formatTaskLine);
      return { type: 'text', content: `任务列表：\n${lines.join('\n')}` };
    }

    const groups = [
      { title: '当前执行', tasks: filterDurableTasks(repo.findByStatus('running')) },
      { title: '待执行', tasks: filterDurableTasks(repo.findByStatus('ready')) },
      { title: '已挂起', tasks: filterDurableTasks(repo.findByStatus('parked')) },
      { title: '已阻塞', tasks: filterDurableTasks(repo.findByStatus('blocked')) },
      { title: '已完成', tasks: filterDurableTasks(repo.findByStatus('done')) },
    ].filter(group => group.tasks.length > 0);

    const lines = ['任务清单：', ''];
    for (const group of groups) {
      lines.push(group.title);
      group.tasks.forEach(task => lines.push(formatTaskLine(task)));
      lines.push('');
    }

    return { type: 'text', content: lines.join('\n').trimEnd() };
  },
};

export const taskCommand: CommandHandler = {
  name: 'task',
  aliases: [],
  description: '任务操作：/task <id> [pause|resume|block|unblock|cancel|done]',
  async execute(args, context) {
    if (args.length === 0) {
      return { type: 'text', content: '用法: /task <id> [action]' };
    }

    const taskId = args[0];
    const action = args[1];

    const task = context.taskEngine['taskRepo'].findById(taskId);
    if (!task) {
      return { type: 'text', content: `任务不存在: ${taskId}` };
    }

    if (!action) {
      // 显示任务详情
      const lines = [
        `任务 #${task.id}`,
        `标题: ${task.title}`,
        `目标: ${task.goal}`,
        `状态: ${task.status}`,
        `摘要: ${task.summary || '无'}`,
        `资源: ${task.resources.join(', ') || '无'}`,
        `创建时间: ${task.createdAt}`,
        `更新时间: ${task.updatedAt}`,
      ];
      return { type: 'text', content: lines.join('\n') };
    }

    try {
      switch (action) {
        case 'pause':
          context.taskEngine.park(taskId, '用户手动暂停', {
            done: [task.summary || '进行中'],
            pending: ['待继续'],
            nextStep: '恢复后继续',
            pauseReason: '用户手动暂停',
          });
          return { type: 'text', content: `任务 #${taskId} 已暂停` };

        case 'resume': {
          const { resumeSummary } = context.taskEngine.resume(taskId);
          return {
            type: 'text',
            content: `任务 #${taskId} 已恢复\n上次进度: ${resumeSummary.lastProgress}\n下一步: ${resumeSummary.nextStep}`,
            data: {
              schedulerAction: 'resume',
              taskId,
              mode: 'resume-parked',
            },
          };
        }

        case 'block': {
          const reason = args.slice(2).join(' ') || '未指定原因';
          context.taskEngine.block(taskId, {
            taskId,
            type: 'manual',
            description: reason,
            status: 'waiting',
          });
          return { type: 'text', content: `任务 #${taskId} 已标记为阻塞: ${reason}` };
        }

        case 'unblock': {
          const newlyProvidedResources = Array.from(new Set(args.slice(2).filter(Boolean)));
          for (const resourcePath of newlyProvidedResources) {
            context.taskEngine.attachResource(taskId, resourcePath);
          }

          context.taskEngine.unblock(taskId);
          return {
            type: 'text',
            content: newlyProvidedResources.length > 0
              ? `任务 #${taskId} 已解除阻塞，并新增资源 ${newlyProvidedResources.join(', ')}`
              : `任务 #${taskId} 已解除阻塞`,
            data: {
              schedulerAction: 'resume',
              taskId,
              mode: 'resume-blocked',
              newlyProvidedResources,
            },
          };
        }

        case 'cancel':
          context.taskEngine.transition(taskId, 'cancelled');
          return { type: 'text', content: `任务 #${taskId} 已取消` };

        case 'done':
          context.taskEngine.transition(taskId, 'done');
          return { type: 'text', content: `任务 #${taskId} 已完成` };

        default:
          return { type: 'text', content: `未知操作: ${action}` };
      }
    } catch (error) {
      return { type: 'text', content: `操作失败: ${(error as Error).message}` };
    }
  },
};
