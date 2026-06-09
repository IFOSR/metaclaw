import type { Config } from '../core/types.js';
import type { FeishuAppConfig } from '../integrations/feishu-app.js';

export interface ResolvedFeishuGatewayConfig {
  enabled: boolean;
  domain: 'feishu' | 'lark';
  connectionMode: 'websocket' | 'webhook';
  appId?: string;
  appSecret?: string;
  appSecretEnv?: string;
  eventPort: number;
  eventPath: string;
  verificationToken?: string;
  source: 'gateway' | 'legacy-integration' | 'default';
}

export function resolveFeishuGatewayConfig(config: Config): ResolvedFeishuGatewayConfig {
  const gatewayFeishu = config.gateway?.platforms?.feishu;
  // Migration-only fallback. New code must write and read gateway.platforms.feishu.
  const legacyFeishu = config.integrations?.feishu;
  const source = gatewayFeishu?.enabled
    ? 'gateway'
    : legacyFeishu?.enabled
      ? 'legacy-integration'
      : 'default';

  return {
    enabled: gatewayFeishu?.enabled ?? legacyFeishu?.enabled ?? false,
    domain: gatewayFeishu?.domain ?? 'feishu',
    connectionMode: gatewayFeishu?.connection_mode ?? legacyFeishu?.mode ?? 'websocket',
    appId: gatewayFeishu?.app_id ?? legacyFeishu?.app_id,
    appSecret: legacyFeishu?.app_secret,
    appSecretEnv: gatewayFeishu?.app_secret_env ?? legacyFeishu?.app_secret_env ?? 'FEISHU_APP_SECRET',
    eventPort: gatewayFeishu?.event_port ?? legacyFeishu?.event_port ?? 8787,
    eventPath: gatewayFeishu?.event_path ?? legacyFeishu?.event_path ?? '/feishu/events',
    verificationToken: gatewayFeishu?.verification_token ?? legacyFeishu?.verification_token,
    source,
  };
}

export function toFeishuAppConfig(config: ResolvedFeishuGatewayConfig): FeishuAppConfig {
  return {
    enabled: config.enabled,
    mode: config.connectionMode,
    app_id: config.appId,
    app_secret: config.appSecret,
    app_secret_env: config.appSecretEnv,
    event_port: config.eventPort,
    event_path: config.eventPath,
    verification_token: config.verificationToken,
  };
}

/**
 * @deprecated Migration-only. Runtime callers should use gateway.platforms.feishu.
 */
export function migrateLegacyFeishuToGatewayConfig(config: Config): Config {
  const legacyFeishu = config.integrations?.feishu;
  const gatewayFeishu = config.gateway?.platforms?.feishu;
  if (gatewayFeishu?.enabled || !legacyFeishu?.enabled) {
    return config;
  }

  return {
    ...config,
    gateway: {
      ...config.gateway,
      enabled: true,
      platforms: {
        ...config.gateway?.platforms,
        feishu: createGatewayFeishuConfigFromLegacy(legacyFeishu),
      },
    },
  };
}

/**
 * @deprecated Migration-only. Converts pre-Gateway integrations.feishu files.
 */
export function createGatewayFeishuConfigFromLegacy(legacyFeishu: NonNullable<Config['integrations']>['feishu']): NonNullable<NonNullable<Config['gateway']>['platforms']>['feishu'] {
  return {
    enabled: legacyFeishu?.enabled ?? false,
    domain: 'feishu',
    connection_mode: legacyFeishu?.mode ?? 'websocket',
    app_id: legacyFeishu?.app_id,
    app_secret_env: legacyFeishu?.app_secret_env ?? 'FEISHU_APP_SECRET',
    event_port: legacyFeishu?.event_port,
    event_path: legacyFeishu?.event_path,
    verification_token: legacyFeishu?.verification_token,
    access: {
      dm_policy: 'pairing',
      allowed_users: [],
      group_policy: 'open',
      require_mention: true,
    },
    delivery: {
      final_markdown_mode: 'card',
      fallback_mode: 'post',
      final_file_fallback: true,
    },
  };
}
