import { readFileSync, existsSync } from 'fs';
import { load } from 'js-yaml';
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
  },
};

/**
 * 加载配置文件
 */
export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const userConfig = load(content) as Partial<Config>;
    const defaultFeishuConfig = DEFAULT_CONFIG.notifications?.feishu ?? { enabled: false };
    const defaultFeishuAppConfig = DEFAULT_CONFIG.integrations?.feishu ?? {
      enabled: false,
      mode: 'websocket',
      app_secret_env: 'FEISHU_APP_SECRET',
      event_port: 8787,
      event_path: '/feishu/events',
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
      },
    };
  } catch (error) {
    console.error(`配置文件加载失败: ${configPath}`, error);
    return DEFAULT_CONFIG;
  }
}
