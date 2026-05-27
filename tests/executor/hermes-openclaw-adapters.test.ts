import { describe, expect, it } from 'vitest';
import { DeepSeekTuiAdapter } from '../../src/executor/deepseek-tui.js';
import { HermesAgentAdapter } from '../../src/executor/hermes-agent.js';
import { OpenClawAdapter } from '../../src/executor/openclaw.js';
import { createExecutor, createExecutorByName } from '../../src/executor/factory.js';

describe('HermesAgentAdapter', () => {
  it('uses hermes headless mode with approvals and hooks bypassed', () => {
    const adapter = new HermesAgentAdapter({ command: 'hermes', timeout: 300 });
    const args = (adapter as any).buildSpawnArgs('test prompt');

    expect(args).toEqual(['--oneshot', 'test prompt', '--yolo', '--accept-hooks']);
  });
});

describe('OpenClawAdapter', () => {
  it('uses openclaw local agent json mode', () => {
    const adapter = new OpenClawAdapter({ command: 'openclaw', timeout: 300 });
    const args = (adapter as any).buildSpawnArgs('test prompt');

    expect(args).toEqual(['agent', '--message', 'test prompt', '--local', '--json']);
  });
});

describe('DeepSeekTuiAdapter', () => {
  it('uses deepseek-tui non-interactive auto exec mode', () => {
    const adapter = new DeepSeekTuiAdapter({ command: 'deepseek-tui', timeout: 300 });
    const args = (adapter as any).buildSpawnArgs('test prompt');

    expect(args).toEqual(['exec', '--auto', 'test prompt']);
  });
});

describe('createExecutorByName', () => {
  it('creates adapters for registered default executor profiles', () => {
    const config = { timeout: 300, workspaceRoot: '/repo' };

    expect(createExecutorByName('codex-cli', config)?.name).toBe('codex-cli');
    expect(createExecutorByName('claude-code', config)?.name).toBe('claude-code');
    expect(createExecutorByName('hermes-agent', config)?.name).toBe('hermes-agent');
    expect(createExecutorByName('deepseek-tui', config)?.name).toBe('deepseek-tui');
  });
});

describe('createExecutor', () => {
  it('creates adapters from configured local executor commands', () => {
    const config = { timeout: 300, workspaceRoot: '/repo' };

    expect(createExecutor({ ...config, command: 'codex' }).name).toBe('codex-cli');
    expect(createExecutor({ ...config, command: 'claude' }).name).toBe('claude-code');
    expect(createExecutor({ ...config, command: 'hermes' }).name).toBe('hermes-agent');
    expect(createExecutor({ ...config, command: 'deepseek' }).name).toBe('deepseek-tui');
    expect(createExecutor({ ...config, command: 'deepseek-tui' }).name).toBe('deepseek-tui');
    expect(createExecutor({ ...config, command: 'openclaw' }).name).toBe('openclaw');
  });
});
