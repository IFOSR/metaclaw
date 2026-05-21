import { describe, expect, it } from 'vitest';
import { HermesAgentAdapter } from '../../src/executor/hermes-agent.js';
import { OpenClawAdapter } from '../../src/executor/openclaw.js';
import { createExecutor, createExecutorByName } from '../../src/executor/factory.js';

describe('HermesAgentAdapter', () => {
  it('uses hermes non-interactive chat mode', () => {
    const adapter = new HermesAgentAdapter({ command: 'hermes', timeout: 300 });
    const args = (adapter as any).buildSpawnArgs('test prompt');

    expect(args).toEqual(['chat', '-q', 'test prompt', '-Q']);
  });
});

describe('OpenClawAdapter', () => {
  it('uses openclaw local agent json mode', () => {
    const adapter = new OpenClawAdapter({ command: 'openclaw', timeout: 300 });
    const args = (adapter as any).buildSpawnArgs('test prompt');

    expect(args).toEqual(['agent', '--message', 'test prompt', '--local', '--json']);
  });
});

describe('createExecutorByName', () => {
  it('creates adapters for registered default executor profiles', () => {
    const config = { timeout: 300, workspaceRoot: '/repo' };

    expect(createExecutorByName('codex-cli', config)?.name).toBe('codex-cli');
    expect(createExecutorByName('claude-code', config)?.name).toBe('claude-code');
    expect(createExecutorByName('hermes-agent', config)?.name).toBe('hermes-agent');
  });
});

describe('createExecutor', () => {
  it('creates adapters from configured local executor commands', () => {
    const config = { timeout: 300, workspaceRoot: '/repo' };

    expect(createExecutor({ ...config, command: 'codex' }).name).toBe('codex-cli');
    expect(createExecutor({ ...config, command: 'claude' }).name).toBe('claude-code');
    expect(createExecutor({ ...config, command: 'hermes' }).name).toBe('hermes-agent');
    expect(createExecutor({ ...config, command: 'openclaw' }).name).toBe('openclaw');
  });
});
