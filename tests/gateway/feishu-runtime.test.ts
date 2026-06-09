import { describe, expect, it, vi } from 'vitest';
import { startFeishuRuntimeBridge } from '../../src/gateway/feishu-runtime.js';
import type { Config } from '../../src/core/types.js';

describe('Feishu runtime bridge', () => {
  const baseConfig: Config = {
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
    integrations: {
      feishu: {
        enabled: true,
        mode: 'websocket',
        app_id: 'cli_test',
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

  it('starts the existing Feishu bridge and reports websocket readiness', async () => {
    const bridge = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const session = {
      appendSystemMessage: vi.fn(),
    };

    const runtimeBridge = await startFeishuRuntimeBridge(
      baseConfig,
      session as any,
      () => bridge,
    );

    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(session.appendSystemMessage).toHaveBeenCalledWith('→ 飞书长连接桥接已启动，等待飞书消息');
    await runtimeBridge?.stop();
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps startup alive when Feishu bridge creation fails', async () => {
    const session = {
      appendSystemMessage: vi.fn(),
    };

    const runtimeBridge = await startFeishuRuntimeBridge(
      baseConfig,
      session as any,
      () => {
        throw new Error('missing secret');
      },
    );

    expect(runtimeBridge).toBeNull();
    expect(session.appendSystemMessage).toHaveBeenCalledWith('⚠️ 飞书应用桥接未启动: missing secret');
  });
});
