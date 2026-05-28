import type { CommandHandler, CommandContext, CommandResult } from './router.js';
import { filterDurableTasks, MANAGEABLE_TASK_STATUSES, type TaskClearScope } from '../core/task-routing.js';
import { buildMaterialSummary, extractMaterialTextSnippets, isWebLink, splitTaskResources } from '../core/material-utils.js';
import type { Task, TaskStatus } from '../core/types.js';

const CLEAR_SCOPE_STATUSES: Record<TaskClearScope, TaskStatus[]> = {
  all: MANAGEABLE_TASK_STATUSES,
  parked: ['parked'],
  blocked: ['blocked'],
};

const CLEAR_SCOPE_LABELS: Record<TaskClearScope, string> = {
  all: '所有未完成任务',
  parked: '挂起任务',
  blocked: '阻塞任务',
};

function parseClearScope(value: string | undefined): TaskClearScope | null {
  if (!value || value === 'all' || value === 'active' || value === 'unfinished') {
    return 'all';
  }

  if (value === 'parked' || value === 'paused') {
    return 'parked';
  }

  if (value === 'blocked') {
    return 'blocked';
  }

  return null;
}

export function cancelTasksByScope(
  context: CommandContext,
  scope: TaskClearScope,
  reason = `用户清空${CLEAR_SCOPE_LABELS[scope]}`,
): { cancelled: Task[]; runningCancelled: boolean } {
  const repo = context.taskEngine['taskRepo'];
  const statuses = CLEAR_SCOPE_STATUSES[scope];
  const candidates = filterDurableTasks(repo.findAll())
    .filter(task => statuses.includes(task.status));
  const runningCancelled = candidates.some(task => task.status === 'running');

  for (const task of candidates) {
    context.taskEngine.cancel(task.id, reason);
  }

  if (runningCancelled) {
    context.executor.abort();
  }

  return { cancelled: candidates, runningCancelled };
}

export function formatTaskClearResult(scope: TaskClearScope, cancelled: Task[], runningCancelled = false): string {
  const lines = [
    `已清空${CLEAR_SCOPE_LABELS[scope]}：取消 ${cancelled.length} 个任务`,
  ];

  if (cancelled.length === 0) {
    lines.push('→ 没有匹配的可清空任务');
    return lines.join('\n');
  }

  if (runningCancelled) {
    lines.push('→ 已中止当前执行器，避免被取消任务继续输出');
  }

  lines.push(
    ...cancelled.map(task => `  - #${task.id} [${task.status.toUpperCase()}] ${task.title}`),
  );
  return lines.join('\n');
}

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

function buildStatusExplanation(task: {
  status: string;
  lastSchedulingReason: string;
  lastInterruptionReason: string;
  dependencies: Array<{ status: string; description: string }>;
}): string {
  if (task.status === 'blocked') {
    return task.dependencies.find(dep => dep.status === 'waiting')?.description || '等待解除阻塞';
  }

  if (task.status === 'parked') {
    return task.lastInterruptionReason || '等待恢复';
  }

  if (task.status === 'ready' || task.status === 'running') {
    return task.lastSchedulingReason || '等待调度';
  }

  if (task.status === 'done') {
    return '已完成，可查看结果摘要与后续动作';
  }

  return '暂无额外说明';
}

function buildLatestNextStep(task: {
  status: string;
  snapshots: Array<{ nextStep: string }>;
  dependencies: Array<{ status: string; description: string }>;
}): string {
  const latestSnapshot = task.snapshots[task.snapshots.length - 1];
  if (latestSnapshot?.nextStep) {
    return latestSnapshot.nextStep;
  }

  if (task.status === 'blocked') {
    const blocker = task.dependencies.find(dep => dep.status === 'waiting')?.description;
    return blocker ? `先解除阻塞：${blocker}` : '先确认阻塞条件';
  }

  if (task.status === 'done') {
    return '如需延续，可基于当前结果创建 follow-up 任务';
  }

  return '继续推进当前任务';
}

function buildRecoveryAction(task: {
  id: string;
  status: string;
  resources?: string[];
  materialSummary?: { status: 'missing' | 'partial' | 'ready'; sufficiency: string };
}): string {
  if (task.status === 'blocked') {
    const hasLinks = (task.resources ?? []).some(resource => isWebLink(resource));
    if (task.materialSummary?.status === 'ready') {
      return `现有材料已具备可读内容，可直接执行 /task ${task.id} unblock；如仍不够，再补充材料：/task ${task.id} unblock [材料路径]`;
    }
    if (hasLinks) {
      return `若现有链接信息已足够，直接执行 /task ${task.id} unblock；如需补材料：/task ${task.id} unblock [材料路径]`;
    }
    return `/task ${task.id} unblock [材料路径]`;
  }

  if (task.status === 'parked') {
    return `/task ${task.id} resume`;
  }

  if (task.status === 'done') {
    return '直接输入 follow-up 指令，基于当前结果继续';
  }

  return '无';
}

export const tasksCommand: CommandHandler = {
  name: 'tasks',
  aliases: [],
  description: '查看任务列表；/tasks clear [all|parked|blocked] 清空未完成任务',
  async execute(args, context) {
    const filter = args[0];
    const repo = context.taskEngine['taskRepo'];
    let tasks;

    if (filter === 'clear') {
      const scope = parseClearScope(args[1]);
      if (!scope) {
        return { type: 'text', content: '用法: /tasks clear [all|parked|blocked]' };
      }

      const result = cancelTasksByScope(context, scope);
      return {
        type: 'text',
        content: formatTaskClearResult(scope, result.cancelled, result.runningCancelled),
      };
    }

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
      const latestInteraction = context.db.prepare(
        'SELECT executor_used, system_output, created_at FROM interactions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(taskId) as { executor_used: string | null; system_output: string | null; created_at: string } | undefined;
      const injectedPreferences = context.memoryEngine
        .list()
        .filter(preference => task.injectedPreferences.includes(preference.id));
      const latestSnapshot = task.snapshots[task.snapshots.length - 1] ?? null;
      const blocker = task.dependencies.find(dep => dep.status === 'waiting')?.description || '无';
      const latestResult = task.summary || latestInteraction?.system_output || '无';
      const latestNextStep = buildLatestNextStep(task);
      const statusExplanation = buildStatusExplanation(task);
      const lastProgress = latestSnapshot?.done.join('；') || task.summary || '无';
      const materialGroups = splitTaskResources(task.resources);
      const materialSnippets = await extractMaterialTextSnippets(task.resources);
      const materialSummary = buildMaterialSummary(task.resources, materialSnippets);
      const recoveryAction = buildRecoveryAction({
        ...task,
        materialSummary,
      });

      const lines = [
        `任务视图 #${task.id}`,
        `标题: ${task.title}`,
        `目标: ${task.goal}`,
        '',
        `当前状态: ${task.status}`,
        `状态说明: ${statusExplanation}`,
        `上次做到: ${lastProgress}`,
        `最新结果摘要: ${latestResult}`,
        `最新下一步: ${latestNextStep}`,
        `当前阻塞: ${blocker}`,
        `材料概览: ${materialSummary.overview}`,
        `材料状态: ${materialSummary.sufficiency}`,
        `关联材料: ${task.resources.join(', ') || '无'}`,
        `本地文件材料: ${materialGroups.files.join(', ') || '无'}`,
        `网页链接材料: ${materialGroups.links.join(', ') || '无'}`,
        `任务产物: ${task.artifacts.join(', ') || '无'}`,
        `恢复操作: ${recoveryAction}`,
        '',
        `最近执行器: ${latestInteraction?.executor_used || '无'}`,
        `最近调度原因: ${task.lastSchedulingReason || '无'}`,
        `最近中断原因: ${task.lastInterruptionReason || '无'}`,
        `最新快照时间: ${latestSnapshot ? latestSnapshot.createdAt : '无'}`,
        `创建时间: ${task.createdAt}`,
        `更新时间: ${task.updatedAt}`,
      ];
      if (injectedPreferences.length > 0) {
        lines.push('', '注入偏好:');
        injectedPreferences.forEach(preference => {
          const subjectText = preference.subject ? ` (${preference.subject})` : '';
          lines.push(`  - [${preference.scope}]${subjectText} ${preference.content}`);
        });
      }
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
          context.taskEngine.cancel(taskId);
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
