import type { ExecutorAdapter } from './adapter.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexCliAdapter } from './codex-cli.js';
import { DeepSeekTuiAdapter } from './deepseek-tui.js';
import { HermesAgentAdapter } from './hermes-agent.js';
import { OpenClawAdapter } from './openclaw.js';
import { PiAgentAdapter } from './pi-agent.js';

/**
 * @deprecated Legacy compatibility factory. Production entrypoints must use
 * createDefaultExecutor()/ExecutorRegistry from execution/execution-runtime instead.
 */
export function createExecutor(config: { command: string; timeout: number; maxDuration?: number; workspaceRoot?: string }): ExecutorAdapter {
  if (config.command === 'codex') {
    return new CodexCliAdapter(config);
  }

  if (config.command === 'claude') {
    return new ClaudeCodeAdapter(config);
  }

  if (config.command === 'hermes') {
    return new HermesAgentAdapter(withLongResearchTimeoutDefaults(config));
  }

  if (config.command === 'pi') {
    return new PiAgentAdapter(withLongResearchTimeoutDefaults(config));
  }

  if (config.command === 'deepseek' || config.command === 'deepseek-tui') {
    return new DeepSeekTuiAdapter({ ...config, command: 'deepseek-tui' });
  }

  if (config.command === 'openclaw') {
    return new OpenClawAdapter(config);
  }

  return new ClaudeCodeAdapter(config);
}

function withLongResearchTimeoutDefaults<T extends { timeout: number; maxDuration?: number }>(config: T): T {
  return {
    ...config,
    timeout: Math.max(config.timeout, 900),
    maxDuration: Math.max(config.maxDuration ?? 0, 7200),
  };
}

/**
 * @deprecated Legacy compatibility factory. Production runtime selection must
 * use ExecutorRegistry from execution/execution-runtime instead.
 */
export function createExecutorByName(
  name: string,
  config: { timeout: number; maxDuration?: number; workspaceRoot?: string },
): ExecutorAdapter | null {
  if (name === 'codex-cli') {
    return new CodexCliAdapter({ ...config, command: 'codex' });
  }

  if (name === 'claude-code') {
    return new ClaudeCodeAdapter({ ...config, command: 'claude' });
  }

  if (name === 'hermes-agent') {
    return new HermesAgentAdapter(withLongResearchTimeoutDefaults({ ...config, command: 'hermes' }));
  }

  if (name === 'pi-agent') {
    return new PiAgentAdapter(withLongResearchTimeoutDefaults({ ...config, command: 'pi' }));
  }

  if (name === 'deepseek-tui') {
    return new DeepSeekTuiAdapter({ ...config, command: 'deepseek-tui' });
  }

  if (name === 'openclaw') {
    return new OpenClawAdapter({ ...config, command: 'openclaw' });
  }

  return null;
}
