import type Database from 'better-sqlite3';
import type { TaskEngine } from '../core/task-engine.js';
import type { MemoryEngine } from '../core/memory-engine.js';
import type { OrchestrationEngine } from '../core/orchestration.js';
import type { Config } from '../core/types.js';
import type { ExecutorAdapter } from '../executor/adapter.js';

export interface CommandContext {
  taskEngine: TaskEngine;
  memoryEngine: MemoryEngine;
  orchestration: OrchestrationEngine;
  executor: ExecutorAdapter;
  currentTaskId: string | null;
  db: Database.Database;
  config: Config;
}

export interface CommandResult {
  type: 'text' | 'table' | 'dashboard' | 'confirm' | 'exit';
  content: string;
  data?: unknown;
}

export interface CommandHandler {
  name: string;
  aliases: string[];
  description: string;
  execute(args: string[], context: CommandContext): Promise<CommandResult>;
}

export class CommandRouter {
  private handlers: Map<string, CommandHandler> = new Map();

  register(handler: CommandHandler): void {
    this.handlers.set(handler.name, handler);
    for (const alias of handler.aliases) {
      this.handlers.set(alias, handler);
    }
  }

  parse(input: string): { command: string; args: string[] } | null {
    if (!input.startsWith('/')) return null;
    const parts = input.slice(1).trim().split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);
    return { command, args };
  }

  async execute(input: string, context: CommandContext): Promise<CommandResult> {
    const parsed = this.parse(input);
    if (!parsed) {
      return { type: 'text', content: '无效命令' };
    }

    const handler = this.handlers.get(parsed.command);
    if (!handler) {
      return { type: 'text', content: `未知命令: /${parsed.command}。输入 /help 查看可用命令。` };
    }

    return handler.execute(parsed.args, context);
  }

  getHelp(): string {
    const seen = new Set<string>();
    const lines: string[] = ['可用命令：', ''];

    for (const handler of this.listHandlers()) {
      const aliases = handler.aliases.length > 0 ? ` (别名: ${handler.aliases.map(a => '/' + a).join(', ')})` : '';
      lines.push(`  /${handler.name}${aliases} — ${handler.description}`);
    }

    return lines.join('\n');
  }

  listHandlers(): CommandHandler[] {
    const seen = new Set<string>();
    const handlers: CommandHandler[] = [];
    for (const [, handler] of this.handlers) {
      if (seen.has(handler.name)) continue;
      seen.add(handler.name);
      handlers.push(handler);
    }
    return handlers;
  }
}
