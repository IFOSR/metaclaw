import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/types.js';
import { resolveFeishuGatewayConfig, toFeishuAppConfig } from '../../src/gateway/feishu-config.js';

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

describe('Feishu Gateway config resolution', () => {
  it('uses Gateway Feishu config as the canonical runtime source', () => {
    const config: Config = {
      ...baseConfig(),
      integrations: {
        feishu: {
          enabled: true,
          mode: 'webhook',
          app_id: 'cli_legacy',
          app_secret_env: 'OLD_SECRET',
          event_port: 9999,
          event_path: '/old',
        },
      },
      gateway: {
        enabled: true,
        platforms: {
          feishu: {
            enabled: true,
            domain: 'lark',
            connection_mode: 'websocket',
            app_id: 'cli_gateway',
            app_secret_env: 'NEW_SECRET',
            event_port: 8787,
            event_path: '/feishu/events',
            verification_token: 'new-token',
          },
        },
      },
    };

    expect(resolveFeishuGatewayConfig(config)).toEqual({
      enabled: true,
      domain: 'lark',
      connectionMode: 'websocket',
      appId: 'cli_gateway',
      appSecretEnv: 'NEW_SECRET',
      eventPort: 8787,
      eventPath: '/feishu/events',
      verificationToken: 'new-token',
      source: 'gateway',
    });
  });

  it('uses legacy integration only as migration fallback', () => {
    const config: Config = {
      ...baseConfig(),
      integrations: {
        feishu: {
          enabled: true,
          mode: 'webhook',
          app_id: 'cli_legacy',
          app_secret_env: 'OLD_SECRET',
          event_port: 9999,
          event_path: '/old',
          verification_token: 'old-token',
        },
      },
    };

    expect(resolveFeishuGatewayConfig(config)).toEqual({
      enabled: true,
      domain: 'feishu',
      connectionMode: 'webhook',
      appId: 'cli_legacy',
      appSecretEnv: 'OLD_SECRET',
      eventPort: 9999,
      eventPath: '/old',
      verificationToken: 'old-token',
      source: 'legacy-integration',
    });
  });

  it('converts canonical Gateway config to the existing Feishu bridge adapter shape', () => {
    expect(toFeishuAppConfig({
      enabled: true,
      domain: 'feishu',
      connectionMode: 'websocket',
      appId: 'cli_gateway',
      appSecretEnv: 'FEISHU_APP_SECRET',
      eventPort: 8787,
      eventPath: '/feishu/events',
      source: 'gateway',
    })).toEqual({
      enabled: true,
      mode: 'websocket',
      app_id: 'cli_gateway',
      app_secret: undefined,
      app_secret_env: 'FEISHU_APP_SECRET',
      event_port: 8787,
      event_path: '/feishu/events',
      verification_token: undefined,
    });
  });
});
