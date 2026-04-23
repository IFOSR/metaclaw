import type { ExecutorAdapter } from './adapter.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexCliAdapter } from './codex-cli.js';

export function createExecutor(config: { command: string; timeout: number; maxDuration?: number; workspaceRoot?: string }): ExecutorAdapter {
  if (config.command === 'codex') {
    return new CodexCliAdapter(config);
  }

  return new ClaudeCodeAdapter(config);
}
