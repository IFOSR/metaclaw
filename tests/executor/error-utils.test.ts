import { describe, expect, it } from 'vitest';
import { formatExecutorError, formatExecutorProgress, isRecoverableExecutorFailure } from '../../src/executor/error-utils.js';

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

  it('maps executor idle timeout to a distinct user-facing message', () => {
    expect(formatExecutorError('executor idle timeout')).toBe('执行器空闲超时，长时间无输出或状态变化，请检查执行器是否卡住');
    expect(isRecoverableExecutorFailure('executor idle timeout')).toBe(true);
  });

  it('maps legacy executor max duration timeout to a compatibility message', () => {
    expect(formatExecutorError('executor max duration exceeded')).toBe('执行器历史总时长超限，请升级执行器配置并重试');
    expect(isRecoverableExecutorFailure('executor max duration exceeded')).toBe(true);
  });
});

describe('formatExecutorProgress', () => {
  it('hides related-task filesystem scans and command details from user-facing progress', () => {
    const noisyLines = [
      '[codex-cli] /home/ylfego/Program/metaclaw/metaclaw-tasks/task_vswMcy2tHw/feishu-document.md',
      '[codex-cli] exec',
      `[codex-cli] /bin/bash -lc "find /home/ylfego/Program/metaclaw -path 'task_VezBimwFQ' -maxdepth 5 -type f" in /home/ylfego/Program/metaclaw`,
      '[codex-cli] succeeded in 0ms:',
      '/home/ylfego/Program/metaclaw/metaclaw-tasks/task_VezBimwFQ/metaclaw_self_learning_executor_research.md',
    ];

    for (const line of noisyLines) {
      expect(formatExecutorProgress(line)).toBeUndefined();
    }
  });

  it('keeps concise executor progress that is useful to the user', () => {
    expect(formatExecutorProgress('[codex-cli] 正在检索相关任务')).toBe('正在检索相关任务');
  });
});
