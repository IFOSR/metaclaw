import { readFileSync, existsSync } from 'fs';
import { load } from 'js-yaml';
import { dirname, extname, join } from 'path';
import type { Config } from '../core/types.js';

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
    feishu: {
      enabled: false,
      mode: 'websocket',
      app_secret_env: 'FEISHU_APP_SECRET',
      event_port: 8787,
      event_path: '/feishu/events',
    },
    markdown_preview: {
      enabled: true,
      host: '127.0.0.1',
      port: 8790,
    },
  },
};

/**
 * 加载配置文件
 */
export function loadConfig(configPath: string): Config {
  const resolvedConfigPath = resolveExistingConfigPath(configPath);
  if (!resolvedConfigPath) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(resolvedConfigPath, 'utf-8');
    const userConfig = load(content) as Partial<Config>;
    const defaultFeishuConfig = DEFAULT_CONFIG.notifications?.feishu ?? { enabled: false };
    const defaultFeishuAppConfig = DEFAULT_CONFIG.integrations?.feishu ?? {
      enabled: false,
      mode: 'websocket',
      app_secret_env: 'FEISHU_APP_SECRET',
      event_port: 8787,
      event_path: '/feishu/events',
    };
    const defaultMarkdownPreviewConfig = DEFAULT_CONFIG.integrations?.markdown_preview ?? {
      enabled: true,
      host: '127.0.0.1',
      port: 8790,
    };

    // 深度合并配置
    return {
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
        feishu: {
          ...defaultFeishuAppConfig,
          ...userConfig.integrations?.feishu,
        },
        markdown_preview: {
          ...defaultMarkdownPreviewConfig,
          ...userConfig.integrations?.markdown_preview,
        },
      },
    };
  } catch (error) {
    console.error(`配置文件加载失败: ${resolvedConfigPath}`, error);
    return DEFAULT_CONFIG;
  }
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
