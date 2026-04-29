import { describe, expect, it, vi } from 'vitest';
import { createFeishuSign, FeishuNotifier } from '../../src/notifications/feishu.js';

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
});
