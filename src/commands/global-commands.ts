import { dump } from 'js-yaml';
import type { CommandHandler, CommandContext, CommandResult } from './router.js';

export const dashboardCommand: CommandHandler = {
  name: 'dashboard',
  aliases: [],
  description: '显示任务盘面',
  async execute(args, context) {
    const dashboard = context.orchestration.getDashboard();

    const lines = [
      '┌─ Metaclaw 任务盘面 ─────────────────────────────┐',
      `│ 活跃: ${dashboard.summary.active}  阻塞: ${dashboard.summary.blocked}  暂停: ${dashboard.summary.parked}  完成: ${dashboard.summary.done}`,
      '│',
    ];

    if (dashboard.priorityTask) {
      lines.push('│ 建议优先处理：');
      lines.push(`│   #${dashboard.priorityTask.id} ${dashboard.priorityTask.title}`);
      dashboard.priorityTask.reasons.forEach(r => lines.push(`│     → ${r}`));
      lines.push('│');
    }

    if (dashboard.blockedTasks.length > 0) {
      lines.push('│ 当前卡住：');
      dashboard.blockedTasks.forEach(t => {
        lines.push(`│   #${t.id} ${t.title}`);
        lines.push(`│     → ${t.blockReason}`);
      });
      lines.push('│');
    }

    if (dashboard.readyTasks.length > 0) {
      lines.push('│ 可以处理：');
      dashboard.readyTasks.slice(0, 3).forEach(t => {
        lines.push(`│   #${t.id} ${t.title}`);
      });
    }

    lines.push('└──────────────────────────────────────────────────┘');

    return { type: 'dashboard', content: lines.join('\n'), data: dashboard };
  },
};

export const attachCommand: CommandHandler = {
  name: 'attach',
  aliases: [],
  description: '关联文件到任务：/attach [taskId] <文件路径...>',
  async execute(args, context) {
    if (args.length === 0) {
      return { type: 'text', content: '用法: /attach [taskId] <文件路径...>' };
    }

    const explicitTask = context.taskEngine['taskRepo'].findById(args[0]);
    const targetTaskId = explicitTask?.id ?? context.currentTaskId;
    const resourceArgs = explicitTask ? args.slice(1) : args;

    if (!targetTaskId) {
      return { type: 'text', content: '当前没有活跃任务，请使用 /attach <taskId> <文件路径...>' };
    }

    if (resourceArgs.length === 0) {
      return { type: 'text', content: '用法: /attach [taskId] <文件路径...>' };
    }

    const attachedResources: string[] = [];
    for (const resourcePath of resourceArgs) {
      context.taskEngine.attachResource(targetTaskId, resourcePath);
      attachedResources.push(resourcePath);
    }

    const targetTask = context.taskEngine['taskRepo'].findById(targetTaskId)!;
    const summaryLine = `已关联 ${attachedResources.length} 个文件到任务 #${targetTaskId}: ${attachedResources.join(', ')}`;

    if (targetTask.status === 'blocked') {
      return {
        type: 'text',
        content: `${summaryLine}\n任务 #${targetTaskId} 当前仍为 BLOCKED，可继续执行 /task ${targetTaskId} unblock`,
      };
    }

    return { type: 'text', content: summaryLine };
  },
};

export const historyCommand: CommandHandler = {
  name: 'history',
  aliases: [],
  description: '查看最近交互历史',
  async execute(args, context) {
    const rows = context.db.prepare(
      'SELECT task_id, user_input, created_at FROM interactions ORDER BY created_at DESC LIMIT 10'
    ).all() as Array<{ task_id: string | null; user_input: string; created_at: string }>;

    if (rows.length === 0) {
      return { type: 'text', content: '暂无交互历史' };
    }

    const lines = rows.map((row) => {
      const taskPrefix = row.task_id ? `#${row.task_id}` : '#conversation';
      return `${row.created_at} ${taskPrefix} ${row.user_input}`;
    });

    return { type: 'text', content: `最近交互：\n${lines.join('\n')}` };
  },
};

export const configCommand: CommandHandler = {
  name: 'config',
  aliases: [],
  description: '查看当前配置',
  async execute(args, context) {
    return { type: 'text', content: dump(context.config).trim() };
  },
};

export const exitCommand: CommandHandler = {
  name: 'exit',
  aliases: ['quit', 'q'],
  description: '退出 Metaclaw',
  async execute() {
    return { type: 'exit', content: '再见 👋' };
  },
};

export const helpCommand: CommandHandler = {
  name: 'help',
  aliases: ['h'],
  description: '显示帮助信息',
  async execute(args, context) {
    const help = `
Metaclaw V1 - 任务连续性、偏好记忆与主动编排中枢

任务管理：
  /tasks [active|ready|parked|blocked|done]  查看任务列表
  /tasks clear [all|parked|blocked]          清空/取消未完成、挂起或阻塞任务
  /task <id>                    查看任务详情
  /task <id> pause              暂停任务
  /task <id> resume             恢复任务
  /task <id> block <原因>       标记阻塞
  /task <id> unblock [资源...]  解除阻塞，可附带新材料
  /task <id> done               标记完成
  /task <id> cancel             取消任务

偏好管理：
  /memory                       查看已确认偏好
  /memory search <关键词>       搜索偏好
  /memory add [--scope ...] [--type ...] [--subject ...] <内容>
                                手动添加偏好
  /memory edit <id> [--scope ...] [--type ...] [--subject ...] <新内容>
                                修改偏好
  /memory delete <id>           删除偏好
  /memory candidates            查看候选偏好
  /memory confirm <id> [--scope ...] [--subject ...]
                                确认偏好
  /memory reject <id>           拒绝偏好
  /memory stats                 偏好统计

Executor 管理：
  /executor list                查看已注册 Executor
  /executor register wizard     问答式注册 Executor，包含安装检测和非交互运行方式
  /executor register <name> --command <cmd> --args "... {prompt}" --check "<cmd> --version"
                                一次性注册 Executor 路由画像和运行绑定
  /executor unregister <name>   反注册 Executor，路由不再派发
  /executor route <任务描述>     预览任务会路由到哪个 Executor
  /executor route-feedback      查看最近路由记录

全局命令：
  /dashboard                    显示任务盘面
  /attach [taskId] <文件路径...>  关联文件到当前任务或指定任务
  /history                      查看最近交互历史
  /config                       查看当前配置
  /exit                         退出 Metaclaw
  /help                         显示此帮助

自然语言：
  直接输入任务描述创建新任务
  "暂停" / "继续" 等关键词会自动识别
  高风险外发动作会输出警示并继续进入执行流程，不在客户端等待确认
  候选偏好可直接输入 y / n / e <新内容>
`;
    return { type: 'text', content: help.trim() };
  },
};
