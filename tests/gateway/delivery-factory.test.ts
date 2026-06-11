import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/types.js';
import { createGatewayDeliveryRouter } from '../../src/gateway/delivery-factory.js';

function configWithHomeChannel(homeChannel?: string): Config {
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
    gateway: {
      enabled: true,
      platforms: {
        feishu: {
          enabled: true,
          app_id: 'cli_test',
          app_secret_env: 'MISSING_SECRET',
          ...(homeChannel ? { home_channel: homeChannel } : {}),
        },
      },
    },
  };
}

describe('createGatewayDeliveryRouter', () => {
  it('resolves home target from Gateway Feishu home_channel', async () => {
    const router = createGatewayDeliveryRouter(configWithHomeChannel('oc_home'), {} as never);

    const result = await router.send('home', {
      kind: 'notice',
      markdown: 'hello home',
      visibility: 'user',
      fallbackPolicy: 'split',
    });

    expect(result).toEqual({
      ok: false,
      target: {
        kind: 'platform',
        platform: 'feishu',
        id: 'oc_home',
      },
      method: 'card',
      error: 'Feishu Gateway app credentials are not configured',
    });
  });

  it('reports missing home channel explicitly', async () => {
    const router = createGatewayDeliveryRouter(configWithHomeChannel(), {} as never);

    await expect(router.send('home', {
      kind: 'notice',
      markdown: 'hello home',
      visibility: 'user',
      fallbackPolicy: 'split',
    })).resolves.toEqual({
      ok: false,
      target: { kind: 'home' },
      method: 'noop',
      error: 'home channel is not configured',
    });
  });
});
