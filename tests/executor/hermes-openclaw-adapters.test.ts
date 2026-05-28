import { describe, expect, it } from 'vitest';
import { DeepSeekTuiAdapter } from '../../src/executor/deepseek-tui.js';
import { HermesAgentAdapter } from '../../src/executor/hermes-agent.js';
import { OpenClawAdapter } from '../../src/executor/openclaw.js';
import { PiAgentAdapter } from '../../src/executor/pi-agent.js';
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

describe('PiAgentAdapter', () => {
  it('uses pi prompt mode with Metaclaw web search tools enabled for non-interactive execution', () => {
    const adapter = new PiAgentAdapter({ command: 'pi', timeout: 300 });
    const args = (adapter as any).buildSpawnArgs('test prompt');

    expect(args).toEqual(expect.arrayContaining([
      '--no-extensions',
      '--extension',
      '--tools',
      'web_search,web_fetch,bash,read,write,edit,grep,find,ls',
      '--append-system-prompt',
      '-p',
      'test prompt',
    ]));
    expect(args[args.indexOf('--extension') + 1]).toContain('metaclaw-web-tools.ts');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('Use web_search automatically');
  });
});

describe('createExecutorByName', () => {
  it('creates adapters for registered default executor profiles', () => {
    const config = { timeout: 300, workspaceRoot: '/repo' };

    expect(createExecutorByName('codex-cli', config)?.name).toBe('codex-cli');
    expect(createExecutorByName('claude-code', config)?.name).toBe('claude-code');
    expect(createExecutorByName('hermes-agent', config)?.name).toBe('hermes-agent');
    expect(createExecutorByName('deepseek-tui', config)?.name).toBe('deepseek-tui');
    expect(createExecutorByName('pi-agent', config)?.name).toBe('pi-agent');
  });

  it.each([
    'hermes-agent',
    'pi-agent',
  ])('uses longer timeout defaults for long-running research executor %s', (name) => {
    const executor = createExecutorByName(name, {
      timeout: 300,
      maxDuration: 3600,
      workspaceRoot: '/repo',
    }) as any;

    expect(executor.config.timeout).toBe(900);
    expect(executor.config.maxDuration).toBe(7200);
  });
});

describe('createExecutor', () => {
  it('creates adapters from configured local executor commands', () => {
    const config = { timeout: 300, workspaceRoot: '/repo' };

    expect(createExecutor({ ...config, command: 'codex' }).name).toBe('codex-cli');
    expect(createExecutor({ ...config, command: 'claude' }).name).toBe('claude-code');
    expect(createExecutor({ ...config, command: 'hermes' }).name).toBe('hermes-agent');
    expect(createExecutor({ ...config, command: 'pi' }).name).toBe('pi-agent');
    expect(createExecutor({ ...config, command: 'deepseek' }).name).toBe('deepseek-tui');
    expect(createExecutor({ ...config, command: 'deepseek-tui' }).name).toBe('deepseek-tui');
    expect(createExecutor({ ...config, command: 'openclaw' }).name).toBe('openclaw');
  });

  it.each([
    ['hermes', 'hermes-agent'],
    ['pi', 'pi-agent'],
  ] as const)('uses longer timeout defaults when %s is configured as the default executor', (command, expectedName) => {
    const executor = createExecutor({
      command,
      timeout: 300,
      maxDuration: 3600,
      workspaceRoot: '/repo',
    }) as any;

    expect(executor.name).toBe(expectedName);
    expect(executor.config.timeout).toBe(900);
    expect(executor.config.maxDuration).toBe(7200);
  });
});
