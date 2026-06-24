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

  it('sends task-completed notifications as Feishu interactive Markdown cards', async () => {
    const postJson = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
    const notifier = new FeishuNotifier({
      enabled: true,
      webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
    }, { postJson });

    await notifier.notifyTaskCompleted({
      taskId: 'task_123',
      title: '后台恢复任务',
      summary: '已经完成恢复后的调研',
      output: 'full output',
      artifactPaths: ['/tmp/report.md'],
      durationMs: 1200,
      executionMode: 'resume-blocked',
      origin: 'system',
      recoveryTrigger: {
        kind: 'timer-recheck',
        blockedReason: '执行器网络连接失败',
        triggerReason: '定时检查确认执行器可用',
      },
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
                content: expect.stringContaining('MetaClaw 旧阻塞任务已完成'),
              }),
            }),
          ],
        }),
      },
    );
    const body = postJson.mock.calls[0][1] as { card: { elements: Array<{ text: { content: string } }> } };
    const content = body.card.elements[0].text.content;
    expect(content).toContain('触发方式：后台恢复');
    expect(content).toContain('原阻塞原因：执行器网络连接失败');
    expect(content).toContain('恢复原因：定时检查确认执行器可用');
  });

  it('keeps ordinary task-completed notification wording for fresh tasks', async () => {
    const postJson = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
    const notifier = new FeishuNotifier({
      enabled: true,
      webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
    }, { postJson });

    await notifier.notifyTaskCompleted({
      taskId: 'task_fresh',
      title: '新任务',
      summary: '新任务完成',
      output: 'full output',
      artifactPaths: [],
      durationMs: 1200,
      executionMode: 'fresh',
      origin: 'user',
    });

    const body = postJson.mock.calls[0][1] as { card: { elements: Array<{ text: { content: string } }> } };
    expect(body.card.elements[0].text.content).toContain('MetaClaw 后台任务已完成');
    expect(body.card.elements[0].text.content).not.toContain('旧阻塞任务已完成');
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

  it('sends task-completed notifications through the Gateway home channel', async () => {
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

    await notifier.notifyTaskCompleted({
      taskId: 'task_123',
      title: '后台恢复任务',
      summary: '已经完成恢复后的调研',
      output: 'full output',
      artifactPaths: ['/tmp/report.md'],
      durationMs: 1200,
      executionMode: 'resume-blocked',
      origin: 'system',
      recoveryTrigger: {
        kind: 'timer-recheck',
        blockedReason: '执行器网络连接失败',
        triggerReason: '定时检查确认执行器可用',
      },
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith(
      'oc_home',
      expect.stringContaining('MetaClaw 旧阻塞任务已完成'),
    );
  });
});
