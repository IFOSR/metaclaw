import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../core/types.js';
import type { SessionSnapshot } from '../session/metaclaw-session.js';
import type { MetaclawSession } from '../session/metaclaw-session.js';

export interface FeishuAppConfig {
  enabled: boolean;
  mode?: 'websocket' | 'webhook';
  app_id?: string;
  app_secret?: string;
  app_secret_env?: string;
  event_port: number;
  event_path: string;
  verification_token?: string;
}

interface JsonResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

interface FeishuAppClientDeps {
  postJson?: (url: string, body: Record<string, unknown>, headers?: Record<string, string>) => Promise<JsonResponse>;
  deleteJson?: (url: string, headers?: Record<string, string>) => Promise<JsonResponse>;
  nowMs?: () => number;
}

interface TenantTokenState {
  token: string;
  expiresAtMs: number;
}

const FEISHU_TYPING_REACTION = 'Typing';

type FeishuPostRow = Array<{
  tag: 'md';
  text: string;
}>;

interface FeishuPostContent {
  zh_cn: {
    title?: string;
    content: FeishuPostRow[];
  };
}

interface FeishuWebhookPostContent {
  post: FeishuPostContent;
}

interface FeishuMarkdownCard {
  config: {
    wide_screen_mode: boolean;
  };
  elements: Array<
    {
      tag: 'div';
      text: {
        tag: 'lark_md';
        content: string;
      };
    }
  >;
}

const MARKDOWN_FENCE_OPEN_RE = /^```([^\n`]*)\s*$/;
const MARKDOWN_FENCE_CLOSE_RE = /^```\s*$/;

export class FeishuAppClient {
  private tenantToken: TenantTokenState | null = null;
  private readonly postJson: (url: string, body: Record<string, unknown>, headers?: Record<string, string>) => Promise<JsonResponse>;
  private readonly deleteJson: (url: string, headers?: Record<string, string>) => Promise<JsonResponse>;
  private readonly nowMs: () => number;

  constructor(
    private readonly config: Required<Pick<FeishuAppConfig, 'app_id' | 'app_secret'>>,
    deps: FeishuAppClientDeps = {},
  ) {
    this.postJson = deps.postJson ?? defaultPostJson;
    this.deleteJson = deps.deleteJson ?? defaultDeleteJson;
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  async getTenantAccessToken(): Promise<string> {
    if (this.tenantToken && this.tenantToken.expiresAtMs > this.nowMs()) {
      return this.tenantToken.token;
    }

    const response = await this.postJson(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: this.config.app_id,
        app_secret: this.config.app_secret,
      },
    );
    const payload = await response.json() as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };

    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`飞书 tenant_access_token 获取失败: ${payload.msg ?? response.status}`);
    }

    const ttlMs = Math.max((payload.expire ?? 7200) - 300, 60) * 1000;
    this.tenantToken = {
      token: payload.tenant_access_token,
      expiresAtMs: this.nowMs() + ttlMs,
    };
    return this.tenantToken.token;
  }

  async sendTextToChat(chatId: string, text: string): Promise<void> {
    await this.sendMarkdownCardToChat(chatId, text);
  }

  async sendMarkdownCardToChat(chatId: string, markdown: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const response = await this.postJson(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        receive_id: chatId,
        msg_type: 'post',
        content: JSON.stringify(createFeishuMarkdownPostContent(markdown)),
      },
      {
        authorization: `Bearer ${token}`,
      },
    );
    const payload = await response.json() as { code?: number; msg?: string };
    if (!response.ok || payload.code !== 0) {
      throw new Error(`飞书消息发送失败: ${payload.msg ?? response.status}`);
    }
  }

  async addReactionToMessage(messageId: string, emojiType: string): Promise<string | null> {
    const token = await this.getTenantAccessToken();
    const response = await this.postJson(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        reaction_type: {
          emoji_type: emojiType,
        },
      },
      {
        authorization: `Bearer ${token}`,
      },
    );
    const payload = await response.json() as { code?: number; msg?: string; data?: { reaction_id?: string }; reaction_id?: string };
    if (!response.ok || payload.code !== 0) {
      throw new Error(`飞书表情添加失败: ${payload.msg ?? response.status}`);
    }
    return payload.data?.reaction_id ?? payload.reaction_id ?? null;
  }

  async removeReactionFromMessage(messageId: string, reactionId: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const response = await this.deleteJson(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
      {
        authorization: `Bearer ${token}`,
      },
    );
    const payload = await response.json() as { code?: number; msg?: string };
    if (!response.ok || payload.code !== 0) {
      throw new Error(`飞书表情删除失败: ${payload.msg ?? response.status}`);
    }
  }
}

interface FeishuEventBridgeDeps {
  client: Pick<FeishuAppClient, 'addReactionToMessage' | 'removeReactionFromMessage' | 'sendMarkdownCardToChat'>;
  session: MetaclawSession;
  config: FeishuAppConfig;
}

export interface FeishuBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface FeishuIncomingMessageEvent {
  message?: {
    message_id?: unknown;
    chat_id?: unknown;
    message_type?: unknown;
    content?: unknown;
  };
}

interface FeishuMessageSession {
  getSnapshot(): Pick<SessionSnapshot, 'output'>;
  submit(rawInput: string, options?: { awaitAsyncWork?: boolean }): Promise<{ exitRequested: boolean }>;
  appendSystemMessage(...lines: string[]): void;
}

interface FeishuMessageHandlerDeps {
  client: Pick<FeishuAppClient, 'addReactionToMessage' | 'removeReactionFromMessage' | 'sendMarkdownCardToChat'>;
  session: FeishuMessageSession;
  seenMessageIds: Set<string>;
}

type FeishuWebSocketEventHandlers = Parameters<InstanceType<typeof Lark.EventDispatcher>['register']>[0];

export class FeishuEventBridge {
  private server: Server | null = null;
  private readonly seenMessageIds = new Set<string>();

  constructor(private readonly deps: FeishuEventBridgeDeps) {}

  start(): Promise<void> {
    if (this.server) {
      return Promise.resolve();
    }

    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.deps.config.event_port, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    if (!this.server) {
      return Promise.resolve();
    }

    const server = this.server;
    this.server = null;
    return new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url?.split('?')[0] !== this.deps.config.event_path) {
      writeJson(response, 404, { error: 'not_found' });
      return;
    }

    try {
      const payload = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
      const challenge = this.extractChallenge(payload);
      if (challenge) {
        writeJson(response, 200, { challenge });
        return;
      }

      if (!this.isVerified(payload)) {
        writeJson(response, 403, { error: 'invalid_token' });
        return;
      }

      writeJson(response, 200, { code: 0 });
      await this.handleEvent(payload);
    } catch (error) {
      writeJson(response, 400, { error: (error as Error).message });
    }
  }

  private extractChallenge(payload: Record<string, unknown>): string | null {
    if (typeof payload.challenge === 'string') {
      return payload.challenge;
    }

    const event = payload.event as Record<string, unknown> | undefined;
    return typeof event?.challenge === 'string' ? event.challenge : null;
  }

  private isVerified(payload: Record<string, unknown>): boolean {
    const expectedToken = this.deps.config.verification_token;
    if (!expectedToken) {
      return true;
    }

    const header = payload.header as Record<string, unknown> | undefined;
    return payload.token === expectedToken || header?.token === expectedToken;
  }

  private async handleEvent(payload: Record<string, unknown>): Promise<void> {
    const header = payload.header as Record<string, unknown> | undefined;
    const eventType = header?.event_type ?? payload.type;
    if (eventType !== 'im.message.receive_v1') {
      return;
    }

    const event = payload.event as Record<string, unknown> | undefined;
    await handleFeishuMessageEvent(event, {
      client: this.deps.client,
      session: this.deps.session,
      seenMessageIds: this.seenMessageIds,
    });
  }
}

interface FeishuWebSocketBridgeDeps {
  client: Pick<FeishuAppClient, 'addReactionToMessage' | 'removeReactionFromMessage' | 'sendMarkdownCardToChat'>;
  session: MetaclawSession;
  appId: string;
  appSecret: string;
  verificationToken?: string;
}

export class FeishuWebSocketBridge implements FeishuBridge {
  private wsClient: Lark.WSClient | null = null;
  private readonly seenMessageIds = new Set<string>();

  constructor(private readonly deps: FeishuWebSocketBridgeDeps) {}

  async start(): Promise<void> {
    if (this.wsClient) {
      return;
    }

    const eventDispatcher = new Lark.EventDispatcher({
      verificationToken: this.deps.verificationToken,
      loggerLevel: Lark.LoggerLevel.warn,
    }).register(createFeishuWebSocketEventHandlers({
      client: this.deps.client,
      session: this.deps.session,
      seenMessageIds: this.seenMessageIds,
    }));

    this.wsClient = new Lark.WSClient({
      appId: this.deps.appId,
      appSecret: this.deps.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
      onError: error => {
        this.deps.session.appendSystemMessage(`⚠️ 飞书长连接错误: ${error.message}`);
      },
      onReconnecting: () => {
        this.deps.session.appendSystemMessage('↻ 飞书长连接断开，正在重连');
      },
      onReconnected: () => {
        this.deps.session.appendSystemMessage('→ 飞书长连接已恢复');
      },
    });

    await this.wsClient.start({ eventDispatcher });
  }

  stop(): Promise<void> {
    this.wsClient?.close({ force: true });
    this.wsClient = null;
    return Promise.resolve();
  }
}

export function createFeishuWebSocketEventHandlers(deps: FeishuMessageHandlerDeps): FeishuWebSocketEventHandlers {
  return {
    'im.message.receive_v1': async data => {
      await handleFeishuMessageEvent(data, deps);
    },
    'im.message.message_read_v1': () => undefined,
    'im.message.reaction.created_v1': () => undefined,
    'im.message.reaction.deleted_v1': () => undefined,
  };
}

export async function handleFeishuMessageEvent(
  event: FeishuIncomingMessageEvent | undefined,
  deps: FeishuMessageHandlerDeps,
): Promise<boolean> {
  const message = event?.message;
  if (!message) {
    return false;
  }
  const messageId = message?.message_id;
  const chatId = message?.chat_id;
  const messageType = message?.message_type;
  if (typeof messageId !== 'string' || typeof chatId !== 'string' || messageType !== 'text') {
    return false;
  }
  if (deps.seenMessageIds.has(messageId)) {
    return false;
  }
  deps.seenMessageIds.add(messageId);

  const text = parseFeishuTextContent(message.content);
  if (!text) {
    return false;
  }

  let typingReactionId: string | null = null;
  try {
    typingReactionId = await deps.client.addReactionToMessage(messageId, FEISHU_TYPING_REACTION);
  } catch (error) {
    deps.session.appendSystemMessage(`⚠️ 飞书 ${FEISHU_TYPING_REACTION} 表情添加失败: ${(error as Error).message}`);
  }

  try {
    const before = deps.session.getSnapshot().output.length;
    await deps.session.submit(text, { awaitAsyncWork: true });
    const outputLines = deps.session.getSnapshot().output.slice(before);
    const output = formatFeishuReply(outputLines) || '已处理。';
    try {
      for (const chunk of splitForFeishu(output)) {
        await deps.client.sendMarkdownCardToChat(chatId, chunk);
      }
    } catch (error) {
      deps.session.appendSystemMessage(`⚠️ 飞书消息回发失败: ${(error as Error).message}`);
    }
  } finally {
    if (typingReactionId) {
      try {
        await deps.client.removeReactionFromMessage(messageId, typingReactionId);
      } catch (error) {
        deps.session.appendSystemMessage(`⚠️ 飞书 ${FEISHU_TYPING_REACTION} 表情删除失败: ${(error as Error).message}`);
      }
    }
  }
  return true;
}

export function createFeishuBridge(config: Config, session: MetaclawSession): FeishuBridge | null {
  const feishu = config.integrations?.feishu;
  if (!feishu?.enabled || !feishu.app_id) {
    return null;
  }

  const appSecret = resolveAppSecret(feishu);
  if (!appSecret) {
    const secretEnvHint = feishu.app_secret_env
      ? `环境变量 ${feishu.app_secret_env} 未设置`
      : '未配置 app_secret_env';
    throw new Error(`飞书应用已启用，但缺少 app_secret，且${secretEnvHint}`);
  }

  const client = new FeishuAppClient({
    app_id: feishu.app_id,
    app_secret: appSecret,
  });

  if ((feishu.mode ?? 'websocket') === 'webhook') {
    return new FeishuEventBridge({
      config: feishu,
      session,
      client,
    });
  }

  return new FeishuWebSocketBridge({
    session,
    client,
    appId: feishu.app_id,
    appSecret,
    verificationToken: feishu.verification_token,
  });
}

export const createFeishuEventBridge = createFeishuBridge;

export function createFeishuMarkdownPostContent(markdown: string, options: { title?: string } = {}): FeishuPostContent {
  return {
    zh_cn: {
      ...(options.title ? { title: options.title } : {}),
      content: createFeishuMarkdownPostRows(markdown),
    },
  };
}

export function createFeishuWebhookMarkdownPost(markdown: string, title = 'Metaclaw'): FeishuWebhookPostContent {
  return {
    post: createFeishuMarkdownPostContent(markdown, { title }),
  };
}

export function createFeishuMarkdownCard(markdown: string): FeishuMarkdownCard {
  return {
    config: {
      wide_screen_mode: true,
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: markdown,
        },
      },
    ],
  };
}

function createFeishuMarkdownPostRows(markdown: string): FeishuPostRow[] {
  if (!markdown) {
    return [[{ tag: 'md', text: '' }]];
  }
  if (!markdown.includes('```')) {
    return [[{ tag: 'md', text: markdown }]];
  }

  const rows: FeishuPostRow[] = [];
  let current: string[] = [];
  let inCodeBlock = false;

  const flushCurrent = () => {
    if (current.length === 0) {
      return;
    }
    const segment = current.join('\n');
    if (segment.trim()) {
      rows.push([{ tag: 'md', text: segment }]);
    }
    current = [];
  };

  for (const rawLine of markdown.split('\n')) {
    const trimmed = rawLine.trim();
    const isFence = inCodeBlock
      ? MARKDOWN_FENCE_CLOSE_RE.test(trimmed)
      : MARKDOWN_FENCE_OPEN_RE.test(trimmed);

    if (isFence) {
      if (!inCodeBlock) {
        flushCurrent();
      }
      current.push(rawLine);
      inCodeBlock = !inCodeBlock;
      if (!inCodeBlock) {
        flushCurrent();
      }
      continue;
    }

    current.push(rawLine);
  }

  flushCurrent();
  return rows.length > 0 ? rows : [[{ tag: 'md', text: markdown }]];
}

export function resolveAppSecret(config: FeishuAppConfig): string | null {
  if (config.app_secret) {
    return config.app_secret;
  }
  if (config.app_secret_env) {
    return process.env[config.app_secret_env] || null;
  }
  return null;
}

export function parseFeishuTextContent(content: unknown): string | null {
  if (typeof content !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : null;
  } catch {
    return content.trim();
  }
}

export function formatFeishuReply(outputLines: string[]): string {
  const executorAnswer = extractLatestExecutorAnswer(outputLines);
  if (executorAnswer) {
    return executorAnswer;
  }

  return outputLines
    .map(cleanFeishuReplyLine)
    .filter((line): line is string => Boolean(line))
    .join('\n')
    .trim();
}

function cleanFeishuReplyLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  if (
    trimmed.startsWith('> ') ||
    trimmed.startsWith('任务 #') ||
    trimmed.startsWith('[') ||
    trimmed.startsWith('【') ||
    trimmed.startsWith('→ ') ||
    trimmed.startsWith('✓ ') ||
    trimmed.startsWith('┌') ||
    trimmed.startsWith('└') ||
    trimmed.startsWith('│ 下一步:')
  ) {
    return null;
  }

  const taskOutput = trimmed.match(/^[+·•]\s+#task_[^\s]+\s+(.+)$/)?.[1]?.trim();
  if (taskOutput) {
    if (
      /^\d[\d,]*$/.test(taskOutput) ||
      taskOutput === 'tokens used' ||
      taskOutput.includes('执行器') ||
      taskOutput.includes('关联历史')
    ) {
      return null;
    }
    return taskOutput;
  }

  return trimmed;
}

function extractLatestExecutorAnswer(outputLines: string[]): string | null {
  const answerLines: string[] = [];
  let activeTaskId: string | null = null;
  let collecting = false;
  let skippingHistory = false;
  let sawAnswerAfterUsage = false;

  for (const rawLine of outputLines) {
    const trimmed = rawLine.trim();
    const taskLine = trimmed.match(/^[+·•]\s+(#task_[^\s]+)\s*(.*)$/);
    if (!taskLine) {
      if (collecting && (trimmed.startsWith('✓ ') || trimmed.startsWith('┌─ 任务结果'))) {
        break;
      }
      continue;
    }

    const [, taskId, rest = ''] = taskLine;
    const taskOutput = rest.trimEnd();
    if (!activeTaskId || isExecutorStartLine(taskOutput)) {
      activeTaskId = taskId;
      answerLines.length = 0;
      collecting = true;
      skippingHistory = false;
      sawAnswerAfterUsage = false;
      if (isExecutorStartLine(taskOutput)) {
        continue;
      }
    }
    if (taskId !== activeTaskId || !collecting) {
      continue;
    }

    if (isHistoryStartLine(taskOutput)) {
      skippingHistory = true;
      continue;
    }
    if (skippingHistory) {
      if (taskOutput.trim() === 'tokens used') {
        skippingHistory = false;
      } else {
        continue;
      }
    }

    const cleaned = cleanExecutorAnswerLine(taskOutput);
    if (cleaned !== null) {
      if (sawAnswerAfterUsage) {
        answerLines.length = 0;
        sawAnswerAfterUsage = false;
      }
      answerLines.push(cleaned);
    } else if (taskOutput.trim() === 'tokens used') {
      sawAnswerAfterUsage = true;
    }
  }

  const answer = trimBlankLines(answerLines).join('\n').trim();
  const taskSummary = extractLatestTaskSummary(outputLines);
  if (answer && !taskSummary) {
    return answer;
  }
  if (answer && taskSummary && !containsOnlyExecutionHistory(answer, taskSummary)) {
    return answer;
  }
  if (taskSummary) {
    return taskSummary;
  }
  return null;
}

function containsOnlyExecutionHistory(answer: string, taskSummary: string): boolean {
  const normalizedSummary = taskSummary.replace(/^\s*│\s*摘要:\s*/, '').split('\n')[0]?.trim() ?? '';
  if (!normalizedSummary) {
    return false;
  }
  if (answer.includes(normalizedSummary)) {
    return false;
  }
  const summaryPrefix = normalizedSummary.replace(/\.\.\.$/, '').trim();
  return !summaryPrefix || !answer.startsWith(summaryPrefix);
}

function isExecutorStartLine(line: string): boolean {
  return line.includes('已启动') && line.includes('执行器');
}

function isHistoryStartLine(line: string): boolean {
  return line.trim().startsWith('关联历史');
}

function cleanExecutorAnswerLine(line: string): string | null {
  if (!line.trim()) {
    return '';
  }
  const trimmed = line.trim();

  if (
    /^\d[\d,]*$/.test(trimmed) ||
    trimmed === 'tokens used' ||
    trimmed.includes('关联历史') ||
    /^(thinking|reasoning|analyzing|chain of thought)/i.test(trimmed) ||
    trimmed === '执行器正在分析问题'
  ) {
    return null;
  }

  return line;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) {
    start += 1;
  }
  while (end > start && !lines[end - 1]?.trim()) {
    end -= 1;
  }
  return lines.slice(start, end);
}

function extractLatestTaskSummary(outputLines: string[]): string | null {
  let summaryStart = -1;
  for (let index = outputLines.length - 1; index >= 0; index -= 1) {
    if (/^│\s*摘要:\s*/.test(outputLines[index]?.trim() ?? '')) {
      summaryStart = index;
      break;
    }
  }
  if (summaryStart === -1) {
    return null;
  }

  const summaryLines: string[] = [];
  for (let index = summaryStart; index < outputLines.length; index += 1) {
    const trimmed = outputLines[index]?.trim() ?? '';
    if (!trimmed) {
      summaryLines.push('');
      continue;
    }
    if (index > summaryStart && (trimmed.startsWith('│ 下一步:') || trimmed.startsWith('└'))) {
      break;
    }

    if (index === summaryStart) {
      summaryLines.push(trimmed.replace(/^│\s*摘要:\s*/, '').trim());
      continue;
    }

    summaryLines.push(trimmed.replace(/^│\s?/, '').trimEnd());
  }

  const summary = summaryLines.join('\n').trim();
  return summary && summary !== '无' ? summary : null;
}

function splitForFeishu(text: string, maxLength = 3500): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const splitAt = findFeishuSplitPoint(remaining, maxLength);
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function findFeishuSplitPoint(text: string, maxLength: number): number {
  const hardLimit = Math.min(maxLength, text.length);
  const newlineIndex = text.lastIndexOf('\n', hardLimit);
  if (newlineIndex > 0) {
    return newlineIndex + 1;
  }
  return hardLimit;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf-8');
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function writeJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function defaultPostJson(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });

  return response;
}

async function defaultDeleteJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: 'DELETE',
    headers,
  });

  return response;
}
