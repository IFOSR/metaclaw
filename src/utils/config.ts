import { readFileSync, existsSync, writeFileSync } from 'fs';
import { dump, load } from 'js-yaml';
import { dirname, extname, join } from 'path';
import type { Config } from '../core/types.js';
import { loadEnvFileIfExists } from './env-file.js';
import { createGatewayFeishuConfigFromLegacy, migrateLegacyFeishuToGatewayConfig } from '../gateway/feishu-config.js';

/**
 * 默认配置
 */
const DEFAULT_CONFIG: Config = {
  version: 1,
  executor: {
    command: 'codex',
    timeout: 300,
    max_duration: 3600,
  },
  orchestration: {
    reminder_enabled: true,
    reminder_throttle: 300,
    top_k_preferences: 5,
    blocked_recheck_enabled: true,
    blocked_recheck_interval: 60,
  },
  ui: {
    language: 'zh-CN',
    dashboard_on_start: true,
  },
  notifications: {
    feishu: {
      enabled: false,
    },
  },
  integrations: {
    markdown_preview: {
      enabled: true,
      host: '127.0.0.1',
      port: 8790,
    },
  },
  gateway: {
    enabled: false,
    platforms: {
      feishu: {
        enabled: false,
        domain: 'feishu',
        connection_mode: 'websocket',
        app_secret_env: 'FEISHU_APP_SECRET',
        event_port: 8787,
        event_path: '/feishu/events',
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
      },
    },
  },
};

/**
 * 加载配置文件
 */
export function loadConfig(configPath: string): Config {
  loadEnvFileIfExists(join(dirname(configPath), '.env'));
  const resolvedConfigPath = resolveExistingConfigPath(configPath);
  if (!resolvedConfigPath) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(resolvedConfigPath, 'utf-8');
    const userConfig = load(content) as Partial<Config>;
    const defaultFeishuConfig = DEFAULT_CONFIG.notifications?.feishu ?? { enabled: false };
    const defaultMarkdownPreviewConfig = DEFAULT_CONFIG.integrations?.markdown_preview ?? {
      enabled: true,
      host: '127.0.0.1',
      port: 8790,
    };
    const defaultGatewayFeishuConfig = DEFAULT_CONFIG.gateway?.platforms?.feishu ?? {
      enabled: false,
      domain: 'feishu',
      connection_mode: 'websocket',
      app_secret_env: 'FEISHU_APP_SECRET',
      event_port: 8787,
      event_path: '/feishu/events',
    };
    const legacyFeishuConfig = userConfig.integrations?.feishu
      ? Object.assign(
          {
            mode: 'websocket' as const,
            app_secret_env: 'FEISHU_APP_SECRET',
            event_port: 8787,
            event_path: '/feishu/events',
          },
          userConfig.integrations.feishu,
        )
      : undefined;

    // 深度合并配置
    const mergedConfig: Config = {
      ...DEFAULT_CONFIG,
      ...userConfig,
      executor: { ...DEFAULT_CONFIG.executor, ...userConfig.executor },
      orchestration: { ...DEFAULT_CONFIG.orchestration, ...userConfig.orchestration },
      ui: { ...DEFAULT_CONFIG.ui, ...userConfig.ui },
      notifications: {
        ...DEFAULT_CONFIG.notifications,
        ...userConfig.notifications,
        feishu: {
          ...defaultFeishuConfig,
          ...userConfig.notifications?.feishu,
        },
      },
      integrations: {
        ...DEFAULT_CONFIG.integrations,
        ...userConfig.integrations,
        ...(legacyFeishuConfig ? { feishu: legacyFeishuConfig } : {}),
        markdown_preview: {
          ...defaultMarkdownPreviewConfig,
          ...userConfig.integrations?.markdown_preview,
        },
      },
      gateway: {
        ...DEFAULT_CONFIG.gateway,
        ...userConfig.gateway,
        enabled: userConfig.gateway?.enabled ?? DEFAULT_CONFIG.gateway?.enabled ?? false,
        platforms: {
          ...DEFAULT_CONFIG.gateway?.platforms,
          ...userConfig.gateway?.platforms,
          feishu: {
            ...defaultGatewayFeishuConfig,
            ...userConfig.gateway?.platforms?.feishu,
            access: {
              ...defaultGatewayFeishuConfig.access,
              ...userConfig.gateway?.platforms?.feishu?.access,
            },
            delivery: {
              ...defaultGatewayFeishuConfig.delivery,
              ...userConfig.gateway?.platforms?.feishu?.delivery,
            },
          },
        },
      },
    };
    return migrateLegacyFeishuToGatewayConfig(mergedConfig);
  } catch (error) {
    console.error(`配置文件加载失败: ${resolvedConfigPath}`, error);
    return DEFAULT_CONFIG;
  }
}

/**
 * Migration-only bridge for users who have not started a Gateway build yet.
 * New setup/runtime paths must not write integrations.feishu.
 */
export function migrateLegacyFeishuConfigFileToGateway(configPath: string): boolean {
  const resolvedConfigPath = resolveExistingConfigPath(configPath);
  if (!resolvedConfigPath) {
    return false;
  }

  const rawConfig = objectValue(load(readFileSync(resolvedConfigPath, 'utf-8')));
  const integrations = objectValue(rawConfig.integrations);
  const legacyFeishu = objectValue(integrations.feishu);
  if (legacyFeishu.enabled !== true) {
    return false;
  }

  const gateway = objectValue(rawConfig.gateway);
  const platforms = objectValue(gateway.platforms);
  const existingGatewayFeishu = objectValue(platforms.feishu);
  if (existingGatewayFeishu.enabled === true) {
    return false;
  }

  const appSecretEnv = stringValue(legacyFeishu.app_secret_env, 'FEISHU_APP_SECRET');
  rawConfig.gateway = {
    ...gateway,
    enabled: true,
    platforms: {
      ...platforms,
      feishu: createGatewayFeishuConfigFromLegacy({
        enabled: true,
        mode: legacyFeishu.mode === 'webhook' ? 'webhook' : 'websocket',
        app_id: stringValueOrUndefined(legacyFeishu.app_id),
        app_secret_env: appSecretEnv,
        event_port: numberValue(legacyFeishu.event_port, 8787),
        event_path: stringValue(legacyFeishu.event_path, '/feishu/events'),
        verification_token: stringValueOrUndefined(legacyFeishu.verification_token),
      }),
    },
  };

  if (typeof legacyFeishu.app_secret === 'string' && legacyFeishu.app_secret.length > 0) {
    writeEnvValues(join(dirname(resolvedConfigPath), '.env'), {
      [appSecretEnv]: legacyFeishu.app_secret,
    });
    process.env[appSecretEnv] = legacyFeishu.app_secret;
  }

  delete integrations.feishu;
  if (Object.keys(integrations).length > 0) {
    rawConfig.integrations = integrations;
  } else {
    delete rawConfig.integrations;
  }

  writeFileSync(resolvedConfigPath, dump(rawConfig, { lineWidth: 120 }), 'utf-8');
  return true;
}

function resolveExistingConfigPath(configPath: string): string | null {
  if (existsSync(configPath)) {
    return configPath;
  }

  const configDir = dirname(configPath);
  const requestedExt = extname(configPath);
  const fallbackNames = requestedExt === '.yaml'
    ? ['config.yml', 'config.json']
    : ['config.yaml', 'config.yml', 'config.json'];

  for (const fallbackName of fallbackNames) {
    const fallbackPath = join(configDir, fallbackName);
    if (existsSync(fallbackPath)) {
      return fallbackPath;
    }
  }

  return null;
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringValueOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function writeEnvValues(envPath: string, values: Record<string, string>): void {
  const existingLines = existsSync(envPath)
    ? readFileSync(envPath, 'utf-8').split(/\r?\n/)
    : [];
  const valueMap = new Map(Object.entries(values));
  const written = new Set<string>();
  const lines = existingLines
    .filter((line, index) => index < existingLines.length - 1 || line.trim().length > 0)
    .map(line => {
      const key = line.includes('=') ? line.slice(0, line.indexOf('=')).trim() : '';
      if (!valueMap.has(key)) {
        return line;
      }
      written.add(key);
      return `${key}=${quoteEnvValue(valueMap.get(key) ?? '')}`;
    });
  for (const [key, value] of valueMap) {
    if (!written.has(key)) {
      lines.push(`${key}=${quoteEnvValue(value)}`);
    }
  }
  writeFileSync(envPath, `${lines.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 });
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:-]*$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}
