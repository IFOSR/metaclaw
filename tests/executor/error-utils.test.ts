import { describe, expect, it } from 'vitest';
import { formatExecutorError } from '../../src/executor/error-utils.js';

describe('formatExecutorError', () => {
  it('collapses codex network logs into a concise user-facing message', () => {
    const raw = [
      'Reading additional input from stdin...',
      'OpenAI Codex v0.120.0 (research preview)',
      '--------',
      'workdir: /tmp',
      '2026-04-16T09:15:38.877891Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: failed to lookup address information: nodename nor servname provided, or not known, url: wss://api.openai.com/v1/responses',
      'ERROR: Reconnecting... 2/5',
    ].join('\n');

    expect(formatExecutorError(raw)).toBe('执行器网络连接失败，请检查网络或代理配置');
  });

  it('falls back to the first meaningful error line after removing executor noise', () => {
    const raw = [
      'OpenAI Codex v0.120.0 (research preview)',
      '--------',
      'workdir: /tmp',
      'approval: never',
      'Reading additional input from stdin...',
      'extra detail',
    ].join('\n');

    expect(formatExecutorError(raw)).toBe('Reading additional input from stdin...');
  });
});
