import { createHmac } from 'crypto';
import type { Config } from '../core/types.js';
import { createFeishuWebhookMarkdownCard } from '../integrations/feishu-app.js';
import { NoopNotificationService, type MemoryCandidateNotification, type NotificationService } from './types.js';

export interface FeishuNotificationConfig {
  enabled: boolean;
  webhook_url?: string;
  secret?: string;
}

interface JsonResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

interface FeishuNotifierDeps {
  postJson?: (url: string, body: Record<string, unknown>) => Promise<JsonResponse>;
  nowSeconds?: () => number;
}

export function createFeishuSign(timestamp: string, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac('sha256', stringToSign).update('').digest('base64');
}

export class FeishuNotifier implements NotificationService {
  private readonly postJson: (url: string, body: Record<string, unknown>) => Promise<JsonResponse>;
  private readonly nowSeconds: () => number;

  constructor(
    private readonly config: FeishuNotificationConfig,
    deps: FeishuNotifierDeps = {},
  ) {
    this.postJson = deps.postJson ?? defaultPostJson;
    this.nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  async notifyMemoryCandidate(input: MemoryCandidateNotification): Promise<void> {
    if (!this.config.enabled || !this.config.webhook_url) {
      return;
    }

    const body: Record<string, unknown> = {
      msg_type: 'interactive',
      ...createFeishuWebhookMarkdownCard(this.formatMemoryCandidateText(input)),
    };

    if (this.config.secret) {
      const timestamp = String(this.nowSeconds());
      body.timestamp = timestamp;
      body.sign = createFeishuSign(timestamp, this.config.secret);
    }

    const response = await this.postJson(this.config.webhook_url, body);
    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(`飞书通知发送失败: HTTP ${response.status} ${responseText}`);
    }
  }

  private formatMemoryCandidateText(input: MemoryCandidateNotification): string {
    const sourceText = input.source === 'high-confidence'
      ? '高置信偏好识别'
      : '重复模式识别';

    return [
      'Metaclaw 检测到待确认偏好',
      '',
      `来源：${sourceText}`,
      `候选：${input.pattern}`,
      `ID：${input.observationId}`,
      '',
      `回到 Metaclaw 输入 /memory confirm ${input.observationId} 确认，或 /memory reject ${input.observationId} 忽略。`,
    ].join('\n');
  }
}

async function defaultPostJson(url: string, body: Record<string, unknown>): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return response;
}

export function createNotificationService(config: Config): NotificationService {
  const feishu = config.notifications?.feishu;
  if (!feishu?.enabled || !feishu.webhook_url) {
    return new NoopNotificationService();
  }

  return new FeishuNotifier(feishu);
}
