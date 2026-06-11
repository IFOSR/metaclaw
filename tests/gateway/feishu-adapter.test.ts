import { describe, expect, it } from 'vitest';
import { FeishuGatewayAdapter } from '../../src/gateway/feishu-adapter.js';
import type { Config } from '../../src/core/types.js';

function baseConfig(): Config {
  return {
    version: 1,
    executor: {
      command: 'codex',
      timeout: 300,
    },
    orchestration: {
      reminder_enabled: true,
      reminder_throttle: 300,
      top_k_preferences: 5,
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
  };
}

describe('FeishuGatewayAdapter', () => {
  it('implements GatewayPlatformAdapter and starts as no-op when disabled', async () => {
    const adapter = new FeishuGatewayAdapter(baseConfig(), {} as never);

    expect(adapter.platform).toBe('feishu');
    await expect(adapter.start({ emit: async () => undefined })).resolves.toBeUndefined();
    await expect(adapter.stop()).resolves.toBeUndefined();
  });

  it('rejects invalid send targets without contacting Feishu', async () => {
    const adapter = new FeishuGatewayAdapter(baseConfig(), {} as never);

    await expect(adapter.send({
      kind: 'platform',
      platform: 'slack',
      id: 'channel',
    }, {
      kind: 'final',
      markdown: 'hello',
      visibility: 'user',
      fallbackPolicy: 'split',
    })).resolves.toEqual({
      ok: false,
      target: {
        kind: 'platform',
        platform: 'slack',
        id: 'channel',
      },
      method: 'noop',
      error: 'invalid Feishu target',
    });
  });
});
