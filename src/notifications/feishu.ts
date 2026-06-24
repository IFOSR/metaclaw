import { createHmac } from 'crypto';
import type { Config } from '../core/types.js';
import { createFeishuWebhookMarkdownCard, FeishuAppClient, resolveAppSecret, type FeishuAppConfig } from '../integrations/feishu-app.js';
import { resolveFeishuGatewayConfig, toFeishuAppConfig } from '../gateway/feishu-config.js';
import { NoopNotificationService, type MemoryCandidateNotification, type NotificationService, type TaskCompletedNotification } from './types.js';

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

type FeishuHomeClient = Pick<FeishuAppClient, 'sendMarkdownCardToChat'>;

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
      ...createFeishuWebhookMarkdownCard(formatMemoryCandidateText(input)),
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

  async notifyTaskCompleted(input: TaskCompletedNotification): Promise<void> {
    if (!this.config.enabled || !this.config.webhook_url) {
      return;
    }

    const body: Record<string, unknown> = {
      msg_type: 'interactive',
      ...createFeishuWebhookMarkdownCard(formatTaskCompletedText(input)),
    };

    if (this.config.secret) {
      const timestamp = String(this.nowSeconds());
      body.timestamp = timestamp;
      body.sign = createFeishuSign(timestamp, this.config.secret);
    }

    const response = await this.postJson(this.config.webhook_url, body);
    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(`飞书任务完成通知发送失败: HTTP ${response.status} ${responseText}`);
    }
  }
}

export class FeishuGatewayHomeNotifier implements NotificationService {
  constructor(
    private readonly input: {
      config: FeishuAppConfig;
      homeChannel: string;
      client?: FeishuHomeClient;
    },
  ) {}

  async notifyMemoryCandidate(input: MemoryCandidateNotification): Promise<void> {
    const client = this.input.client ?? this.createClient();
    await client.sendMarkdownCardToChat(this.input.homeChannel, formatMemoryCandidateText(input));
  }

  async notifyTaskCompleted(input: TaskCompletedNotification): Promise<void> {
    const client = this.input.client ?? this.createClient();
    await client.sendMarkdownCardToChat(this.input.homeChannel, formatTaskCompletedText(input));
  }

  private createClient(): FeishuAppClient {
    const appSecret = resolveAppSecret(this.input.config);
    if (!this.input.config.app_id || !appSecret) {
      throw new Error('飞书 Gateway home channel 通知缺少 app_id 或 app_secret');
    }
    return new FeishuAppClient({
      app_id: this.input.config.app_id,
      app_secret: appSecret,
    });
  }
}

function formatMemoryCandidateText(input: MemoryCandidateNotification): string {
  const sourceText = input.source === 'high-confidence'
    ? '高置信偏好识别'
    : '重复模式识别';

  return [
    'Metaclaw 检测到候选偏好',
    '',
    `来源：${sourceText}`,
    `候选：${input.pattern}`,
    `ID：${input.observationId}`,
    '',
    '当前任务不会等待用户确认。系统只会自动写入低风险、高置信偏好；其余候选仅保留备查。',
    `如需长期保存，可稍后在 Metaclaw 输入 /memory confirm ${input.observationId}；不需要则输入 /memory reject ${input.observationId}。`,
  ].join('\n');
}

function formatTaskCompletedText(input: TaskCompletedNotification): string {
  if (input.executionMode === 'resume-blocked') {
    return formatBlockedRecoveryCompletedText(input);
  }

  const summary = input.summary.trim() || firstNonEmptyLine(input.output) || '任务已完成';
  const lines = [
    'MetaClaw 后台任务已完成',
    '',
    `任务：#${input.taskId} ${input.title}`,
    `恢复方式：${formatExecutionMode(input.executionMode)}`,
    `耗时：${(input.durationMs / 1000).toFixed(1)}s`,
    '',
    `摘要：${summary}`,
  ];

  if (input.artifactPaths.length > 0) {
    lines.push('', '产物：', ...input.artifactPaths.map(path => `- ${path}`));
  }

  return lines.join('\n');
}

function formatBlockedRecoveryCompletedText(input: TaskCompletedNotification): string {
  const summary = input.summary.trim() || firstNonEmptyLine(input.output) || '任务已完成';
  const recoveryTrigger = input.recoveryTrigger;
  const lines = [
    'MetaClaw 旧阻塞任务已完成',
    '',
    `任务：#${input.taskId} ${input.title}`,
    `触发方式：${formatRecoveryTrigger(recoveryTrigger, input.origin)}`,
    `原阻塞原因：${recoveryTrigger?.blockedReason || '未知原因'}`,
  ];

  if (recoveryTrigger?.triggerReason) {
    lines.push(`恢复原因：${recoveryTrigger.triggerReason}`);
  }

  if (recoveryTrigger?.sourceInputExcerpt) {
    lines.push(`触发输入：${recoveryTrigger.sourceInputExcerpt}`);
  }

  lines.push(
    `耗时：${(input.durationMs / 1000).toFixed(1)}s`,
    '',
    '答案：',
    summary,
  );

  if (input.artifactPaths.length > 0) {
    lines.push('', '产物：', ...input.artifactPaths.map(path => `- ${path}`));
  }

  return lines.join('\n');
}

function formatRecoveryTrigger(
  trigger: TaskCompletedNotification['recoveryTrigger'],
  origin: TaskCompletedNotification['origin'],
): string {
  if (!trigger) {
    return origin === 'system' ? '后台恢复' : '用户触发恢复';
  }

  if (trigger.kind === 'timer-recheck') return '后台恢复';
  if (trigger.kind === 'user-query-unblocked') return '用户新 query 解除阻塞';
  if (trigger.kind === 'natural-language-resume') return '用户自然语言恢复旧阻塞任务';
  if (trigger.kind === 'explicit-task-command') return '用户显式命令恢复旧阻塞任务';
  if (trigger.kind === 'proposal') return '用户接受恢复建议';
  return origin === 'system' ? '后台恢复' : '用户触发恢复';
}

function formatExecutionMode(mode: TaskCompletedNotification['executionMode']): string {
  if (mode === 'resume-blocked') return '阻塞解除后后台恢复';
  if (mode === 'resume-parked') return '挂起任务恢复';
  if (mode === 'follow-up') return '后续任务';
  return '新任务';
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
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
  if (feishu?.enabled && feishu.webhook_url) {
    return new FeishuNotifier(feishu);
  }

  const gatewayFeishu = resolveFeishuGatewayConfig(config);
  const homeChannel = config.gateway?.platforms?.feishu?.home_channel;
  if (gatewayFeishu.enabled && gatewayFeishu.appId && homeChannel) {
    return new FeishuGatewayHomeNotifier({
      config: toFeishuAppConfig(gatewayFeishu),
      homeChannel,
    });
  }

  return new NoopNotificationService();
}
