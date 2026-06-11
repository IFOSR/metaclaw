import { describe, expect, it, vi } from 'vitest';
import { createFeishuSign, createNotificationService, FeishuGatewayHomeNotifier, FeishuNotifier } from '../../src/notifications/feishu.js';

describe('FeishuNotifier', () => {
  it('sends memory candidate notifications as Feishu interactive Markdown cards', async () => {
    const postJson = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
    const notifier = new FeishuNotifier({
      enabled: true,
      webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
    }, { postJson });

    await notifier.notifyMemoryCandidate({
      observationId: 'obs_123',
      pattern: '凡是长篇调研默认输出 Markdown 文件',
      source: 'high-confidence',
    });

    expect(postJson).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
      {
        msg_type: 'interactive',
        card: expect.objectContaining({
          elements: [
            expect.objectContaining({
              tag: 'div',
              text: expect.objectContaining({
                tag: 'lark_md',
                content: expect.stringContaining('凡是长篇调研默认输出 Markdown 文件'),
              }),
            }),
          ],
        }),
      },
    );
  });

  it('adds timestamp and sign when secret is configured', async () => {
    const postJson = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
    const notifier = new FeishuNotifier({
      enabled: true,
      webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
      secret: 'secret-key',
    }, { postJson, nowSeconds: () => 123456 });

    await notifier.notifyMemoryCandidate({
      observationId: 'obs_123',
      pattern: '长篇调研输出 Markdown 文件',
      source: 'high-confidence',
    });

    expect(postJson).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
      expect.objectContaining({
        timestamp: '123456',
        sign: createFeishuSign('123456', 'secret-key'),
      }),
    );
  });

  it('uses Gateway home channel notifications when webhook notifications are not configured', async () => {
    const notifier = createNotificationService({
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
            app_secret_env: 'FEISHU_SECRET',
            home_channel: 'oc_home',
          },
        },
      },
    });

    expect(notifier).toBeInstanceOf(FeishuGatewayHomeNotifier);
  });

  it('sends Gateway home channel notification through the Feishu app client', async () => {
    const client = {
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };
    const notifier = new FeishuGatewayHomeNotifier({
      config: {
        enabled: true,
        app_id: 'cli_test',
        app_secret: 'secret',
        event_port: 8787,
        event_path: '/feishu/events',
      },
      homeChannel: 'oc_home',
      client,
    });

    await notifier.notifyMemoryCandidate({
      observationId: 'obs_123',
      pattern: '长篇调研输出 Markdown 文件',
      source: 'high-confidence',
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith(
      'oc_home',
      expect.stringContaining('长篇调研输出 Markdown 文件'),
    );
  });
});
