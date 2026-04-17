import { describe, expect, it } from 'vitest';
import { formatExecutorError, isRecoverableExecutorFailure } from '../../src/executor/error-utils.js';

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

    expect(formatExecutorError(raw)).toBe('extra detail');
  });

  it('maps permission-denied executor warnings to a user-facing permission message', () => {
    const raw = [
      'OpenAI Codex v0.120.0 (research preview)',
      'WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)',
    ].join('\n');

    expect(formatExecutorError(raw)).toBe('执行器权限受限，请确认已授予所需目录访问权限后重试');
    expect(isRecoverableExecutorFailure(raw)).toBe(true);
  });

  it('ignores cleanup permission warnings when a more specific error is present later', () => {
    const raw = [
      'WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)',
      'failed to connect to websocket: IO error: failed to lookup address information',
    ].join('\n');

    expect(formatExecutorError(raw)).toBe('执行器网络连接失败，请检查网络或代理配置');
  });
});
