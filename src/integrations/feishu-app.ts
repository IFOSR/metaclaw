import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { existsSync, readFileSync, statSync } from 'fs';
import { basename } from 'path';
import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../core/types.js';
import type { SessionSnapshot } from '../session/metaclaw-session.js';
import type { MetaclawSession } from '../session/metaclaw-session.js';
import { createMarkdownPreviewBaseUrl, createMarkdownPreviewLinks } from './markdown-preview.js';

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
  postForm?: (url: string, form: FormData, headers?: Record<string, string>) => Promise<JsonResponse>;
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

interface FeishuWebhookCardContent {
  card: FeishuMarkdownCard;
}

type FeishuMarkdownCard = FeishuMarkdownCardV1 | FeishuMarkdownCardV2;

interface FeishuMarkdownCardV1 {
  config: {
    wide_screen_mode: boolean;
  };
  header?: {
    template: 'blue';
    title: {
      tag: 'plain_text';
      content: string;
    };
  };
  elements: FeishuMarkdownCardElement[];
}

interface FeishuMarkdownCardV2 {
  schema: '2.0';
  config: {
    wide_screen_mode: boolean;
  };
  header?: FeishuMarkdownCardV1['header'];
  body: {
    elements: FeishuMarkdownCardV2Element[];
  };
}

type FeishuMarkdownCardElement =
  {
      tag: 'div';
      text: {
        tag: 'lark_md';
        content: string;
      };
    };

type FeishuMarkdownCardV2Element =
  | {
      tag: 'markdown';
      content: string;
    }
  | {
      tag: 'table';
      page_size: number;
      row_height: 'low';
      columns: Array<{
        name: string;
        display_name: string;
        data_type: 'text';
        width: 'auto';
      }>;
      rows: Array<Record<string, string>>;
    };

const MARKDOWN_FENCE_OPEN_RE = /^```([^\n`]*)\s*$/;
const MARKDOWN_FENCE_CLOSE_RE = /^```\s*$/;

export class FeishuAppClient {
  private tenantToken: TenantTokenState | null = null;
  private readonly postJson: (url: string, body: Record<string, unknown>, headers?: Record<string, string>) => Promise<JsonResponse>;
  private readonly postForm: (url: string, form: FormData, headers?: Record<string, string>) => Promise<JsonResponse>;
  private readonly deleteJson: (url: string, headers?: Record<string, string>) => Promise<JsonResponse>;
  private readonly nowMs: () => number;

  constructor(
    private readonly config: Required<Pick<FeishuAppConfig, 'app_id' | 'app_secret'>>,
    deps: FeishuAppClientDeps = {},
  ) {
    this.postJson = deps.postJson ?? defaultPostJson;
    this.postForm = deps.postForm ?? defaultPostForm;
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
    const sendCard = async (card: FeishuMarkdownCard) => {
      const response = await this.postJson(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
        {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
        {
          authorization: `Bearer ${token}`,
        },
      );
      const payload = await response.json() as { code?: number; msg?: string };
      if (!response.ok || payload.code !== 0) {
        throw new Error(`飞书消息发送失败: ${payload.msg ?? response.status}`);
      }
    };

    const card = createFeishuMarkdownCard(markdown);
    try {
      await sendCard(card);
    } catch (error) {
      if (!isFeishuTableCard(card) || !isFeishuCardContentError(error)) {
        throw error;
      }
      await sendCard(createFeishuMarkdownCard(markdown, { tableMode: 'markdown' }));
    }
  }

  async uploadFile(filePath: string): Promise<string> {
    const token = await this.getTenantAccessToken();
    const fileStats = statSync(filePath);
    const form = new FormData();
    form.set('file_type', 'stream');
    form.set('file_name', basename(filePath));
    form.set('file', new Blob([readFileSync(filePath)]), basename(filePath));
    form.set('duration', '0');

    const response = await this.postForm(
      'https://open.feishu.cn/open-apis/im/v1/files',
      form,
      {
        authorization: `Bearer ${token}`,
      },
    );
    const payload = await response.json() as {
      code?: number;
      msg?: string;
      data?: { file_key?: string };
      file_key?: string;
    };
    const fileKey = payload.data?.file_key ?? payload.file_key;
    if (!response.ok || payload.code !== 0 || !fileKey) {
      throw new Error(`飞书文件上传失败: ${payload.msg ?? response.status}`);
    }
    void fileStats;
    return fileKey;
  }

  async sendFileToChat(chatId: string, fileKey: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const response = await this.postJson(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
      {
        authorization: `Bearer ${token}`,
      },
    );
    const payload = await response.json() as { code?: number; msg?: string };
    if (!response.ok || payload.code !== 0) {
      throw new Error(`飞书文件消息发送失败: ${payload.msg ?? response.status}`);
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
  client: FeishuMessageClient;
  session: MetaclawSession;
  config: FeishuAppConfig;
  markdownPreview?: FeishuMessageHandlerDeps['markdownPreview'];
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
  subscribe?: (listener: (snapshot: Pick<SessionSnapshot, 'output'>) => void) => () => void;
  submit(rawInput: string, options?: { awaitAsyncWork?: boolean }): Promise<{ exitRequested: boolean }>;
  appendSystemMessage(...lines: string[]): void;
}

export interface FeishuMarkdownPreviewOptions {
  baseUrl: string;
  workspaceRoot: string;
}

type FeishuMessageClient = Pick<FeishuAppClient, 'addReactionToMessage' | 'removeReactionFromMessage' | 'sendMarkdownCardToChat'>
  & Partial<Pick<FeishuAppClient, 'uploadFile' | 'sendFileToChat'>>;

interface FeishuMessageHandlerDeps {
  client: FeishuMessageClient;
  session: FeishuMessageSession;
  seenMessageIds: Set<string>;
  markdownPreview?: FeishuMarkdownPreviewOptions;
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
      markdownPreview: this.deps.markdownPreview,
    });
  }
}

interface FeishuWebSocketBridgeDeps {
  client: FeishuMessageClient;
  session: MetaclawSession;
  appId: string;
  appSecret: string;
  verificationToken?: string;
  markdownPreview?: FeishuMessageHandlerDeps['markdownPreview'];
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
      markdownPreview: this.deps.markdownPreview,
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
    let observedOutputLength = before;
    let progressSendQueue = Promise.resolve();
    const sentProgressSteps = new Set<string>();
    const enqueueProgress = (progressOutput: string) => {
      progressSendQueue = progressSendQueue.then(() =>
        deps.client.sendMarkdownCardToChat(chatId, progressOutput)
          .catch((error) => {
            deps.session.appendSystemMessage(`⚠️ 飞书步骤消息回发失败: ${(error as Error).message}`);
          })
      );
    };
    let unsubscribe: (() => void) | undefined;
    unsubscribe = deps.session.subscribe?.((snapshot) => {
      const newLines = snapshot.output.slice(observedOutputLength);
      observedOutputLength = snapshot.output.length;
      for (const progressOutput of formatFeishuStreamingProgressReplies(newLines, sentProgressSteps)) {
        enqueueProgress(progressOutput);
      }
    });
    try {
      await deps.session.submit(text, { awaitAsyncWork: true });
    } finally {
      unsubscribe?.();
    }
    const outputLines = deps.session.getSnapshot().output.slice(before);
    const progressOutput = deps.session.subscribe
      ? ''
      : formatFeishuProgressReply(outputLines);
    const output = formatFeishuReply(outputLines) || formatFeishuPendingReply(outputLines);
    const reply = appendMarkdownPreviewLinks(output, outputLines, deps.markdownPreview);
    if (!reply) {
      return true;
    }
    try {
      if (progressOutput) {
        enqueueProgress(progressOutput);
      }
      await progressSendQueue;
      for (const chunk of splitForFeishu(reply)) {
        await deps.client.sendMarkdownCardToChat(chatId, chunk);
      }
      await sendArtifactFilesToFeishu(chatId, outputLines, deps);
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
  const markdownPreview = buildFeishuMarkdownPreviewOptions(config);

  if ((feishu.mode ?? 'websocket') === 'webhook') {
    return new FeishuEventBridge({
      config: feishu,
      session,
      client,
      markdownPreview,
    });
  }

  return new FeishuWebSocketBridge({
    session,
    client,
    appId: feishu.app_id,
    appSecret,
    verificationToken: feishu.verification_token,
    markdownPreview,
  });
}

export const createFeishuEventBridge = createFeishuBridge;

export function buildFeishuMarkdownPreviewOptions(config: Config, workspaceRoot = process.cwd()): FeishuMarkdownPreviewOptions | undefined {
  const previewConfig = config.integrations?.markdown_preview;
  if (!previewConfig?.enabled) {
    return undefined;
  }

  return {
    baseUrl: createMarkdownPreviewBaseUrl(previewConfig),
    workspaceRoot,
  };
}

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

export function createFeishuWebhookMarkdownCard(markdown: string): FeishuWebhookCardContent {
  return {
    card: createFeishuMarkdownCard(markdown),
  };
}

export function createFeishuMarkdownCard(
  markdown: string,
  options: { tableMode?: 'native' | 'markdown' } = {},
): FeishuMarkdownCard {
  const { title, content } = extractFeishuCardTitle(markdown);
  const tableMode = options.tableMode ?? 'native';
  if (tableMode === 'native' && hasFeishuMarkdownTable(content)) {
    return {
      schema: '2.0',
      config: {
        wide_screen_mode: true,
      },
      ...(title
        ? {
            header: {
              template: 'blue' as const,
              title: {
                tag: 'plain_text' as const,
                content: title,
              },
            },
          }
        : {}),
      body: {
        elements: createFeishuMarkdownCardV2Elements(content),
      },
    };
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    ...(title
      ? {
          header: {
            template: 'blue' as const,
            title: {
              tag: 'plain_text' as const,
              content: title,
            },
          },
        }
      : {}),
    elements: createFeishuMarkdownCardElements(content, { tableMode }),
  };
}

function extractFeishuCardTitle(markdown: string): { title: string | null; content: string } {
  const lines = markdown.split('\n');
  const firstContentIndex = lines.findIndex(line => line.trim().length > 0);
  if (firstContentIndex === -1) {
    return { title: null, content: markdown };
  }

  const headingMatch = lines[firstContentIndex]?.match(/^#\s+(.+?)\s*$/);
  if (!headingMatch) {
    return { title: null, content: markdown };
  }

  const contentLines = [
    ...lines.slice(0, firstContentIndex),
    ...lines.slice(firstContentIndex + 1),
  ];

  return {
    title: headingMatch[1]?.trim() ?? null,
    content: contentLines.join('\n').replace(/^\n+/, ''),
  };
}

function createFeishuMarkdownCardElements(
  markdown: string,
  options: { tableMode?: 'native' | 'markdown' } = {},
): FeishuMarkdownCardV1['elements'] {
  const segments = splitFeishuMarkdownTableSegments(markdown);
  const elements: FeishuMarkdownCardV1['elements'] = [];

  for (const segment of segments) {
    if (segment.kind === 'markdown') {
      const content = normalizeFeishuMarkdownContent(segment.content).trim();
      if (content) {
        elements.push({
          tag: 'div' as const,
          text: {
            tag: 'lark_md' as const,
            content,
          },
        });
      }
      continue;
    }

    if ((options.tableMode ?? 'native') === 'native') {
      elements.push({
        tag: 'div' as const,
        text: {
          tag: 'lark_md' as const,
          content: segmentToMarkdownTable(segment),
        },
      });
      continue;
    }

    elements.push({
      tag: 'div' as const,
      text: {
        tag: 'lark_md' as const,
        content: formatMarkdownTableAsFeishuMarkdown(segment),
      },
    });
  }

  return elements.length > 0
    ? elements
    : [{
        tag: 'div' as const,
        text: {
          tag: 'lark_md' as const,
          content: '',
        },
      }];
}

function createFeishuMarkdownCardV2Elements(markdown: string): FeishuMarkdownCardV2Element[] {
  const segments = splitFeishuMarkdownTableSegments(markdown);
  const elements: FeishuMarkdownCardV2Element[] = [];

  for (const segment of segments) {
    if (segment.kind === 'markdown') {
      const content = normalizeFeishuMarkdownContent(segment.content).trim();
      if (content) {
        elements.push({
          tag: 'markdown' as const,
          content,
        });
      }
      continue;
    }

    elements.push(createFeishuNativeTableElement(segment));
  }

  return elements.length > 0
    ? elements
    : [{ tag: 'markdown' as const, content: '' }];
}

type FeishuMarkdownSegment =
  | { kind: 'markdown'; content: string }
  | { kind: 'table'; headers: string[]; rows: string[][] };

function splitFeishuMarkdownTableSegments(markdown: string): FeishuMarkdownSegment[] {
  const lines = markdown.split('\n');
  const segments: FeishuMarkdownSegment[] = [];
  let currentMarkdown: string[] = [];
  let inFence = false;
  let index = 0;

  const flushMarkdown = () => {
    if (currentMarkdown.length === 0) {
      return;
    }
    segments.push({ kind: 'markdown', content: currentMarkdown.join('\n') });
    currentMarkdown = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (MARKDOWN_FENCE_OPEN_RE.test(line) || MARKDOWN_FENCE_CLOSE_RE.test(line)) {
      inFence = !inFence;
      currentMarkdown.push(line);
      index += 1;
      continue;
    }

    if (!inFence && isMarkdownTableHeaderAt(lines, index)) {
      const table = parseMarkdownTableAt(lines, index);
      if (table) {
        flushMarkdown();
        segments.push({
          kind: 'table',
          headers: table.headers,
          rows: table.rows,
        });
        index = table.nextIndex;
        continue;
      }
    }

    currentMarkdown.push(line);
    index += 1;
  }

  flushMarkdown();
  return segments;
}

function isMarkdownTableHeaderAt(lines: string[], index: number): boolean {
  const header = lines[index];
  const separator = lines[index + 1];
  if (!header || !separator) {
    return false;
  }
  return isMarkdownTableRow(header) && isMarkdownTableSeparator(separator);
}

function parseMarkdownTableAt(
  lines: string[],
  startIndex: number,
): { headers: string[]; rows: string[][]; nextIndex: number } | null {
  const headers = parseMarkdownTableRow(lines[startIndex] ?? '');
  if (headers.length === 0) {
    return null;
  }

  const rows: string[][] = [];
  let index = startIndex + 2;
  while (index < lines.length && isMarkdownTableRow(lines[index] ?? '')) {
    const row = parseMarkdownTableRow(lines[index] ?? '');
    rows.push(headers.map((_, cellIndex) => row[cellIndex] ?? ''));
    index += 1;
  }

  return rows.length > 0
    ? { headers, rows, nextIndex: index }
    : null;
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && parseMarkdownTableRow(trimmed).length >= 2;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = parseMarkdownTableRow(line);
  return cells.length >= 2 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutLeadingPipe = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutTrailingPipe = withoutLeadingPipe.endsWith('|')
    ? withoutLeadingPipe.slice(0, -1)
    : withoutLeadingPipe;
  return withoutTrailingPipe.split('|').map(cell => cell.trim());
}

function formatMarkdownTableAsFeishuMarkdown(segment: Extract<FeishuMarkdownSegment, { kind: 'table' }>): string {
  const [primaryHeader = '项目', ...detailHeaders] = segment.headers;
  return segment.rows.map((row) => {
    const [primaryCell = '', ...detailCells] = row;
    const lines = [`**${primaryHeader}：${primaryCell || '未命名'}**`];
    detailHeaders.forEach((header, index) => {
      lines.push(`- **${header || `列 ${index + 2}`}**：${detailCells[index] ?? ''}`);
    });
    return lines.join('\n');
  }).join('\n\n');
}

function createFeishuNativeTableElement(segment: Extract<FeishuMarkdownSegment, { kind: 'table' }>): FeishuMarkdownCardV2Element {
  const columns = segment.headers.map((header, index) => ({
    name: `col_${index}`,
    display_name: header || `列 ${index + 1}`,
    data_type: 'text' as const,
    width: 'auto' as const,
  }));

  return {
    tag: 'table' as const,
    page_size: Math.max(segment.rows.length, 1),
    row_height: 'low' as const,
    columns,
    rows: segment.rows.map(row =>
      Object.fromEntries(columns.map((column, index) => [column.name, row[index] ?? '']))
    ),
  };
}

function segmentToMarkdownTable(segment: Extract<FeishuMarkdownSegment, { kind: 'table' }>): string {
  return [
    `| ${segment.headers.join(' | ')} |`,
    `| ${segment.headers.map(() => '---').join(' | ')} |`,
    ...segment.rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function hasFeishuMarkdownTable(markdown: string): boolean {
  return splitFeishuMarkdownTableSegments(markdown).some(segment => segment.kind === 'table');
}

function isFeishuTableCard(card: FeishuMarkdownCard): boolean {
  return 'schema' in card && card.body.elements.some(element => element.tag === 'table');
}

function isFeishuCardContentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Failed to create card content') || message.includes('200905');
}

function normalizeFeishuMarkdownContent(markdown: string): string {
  let inFence = false;
  return markdown.split('\n').map(line => {
    if (MARKDOWN_FENCE_OPEN_RE.test(line) || MARKDOWN_FENCE_CLOSE_RE.test(line)) {
      inFence = !inFence;
      return line;
    }

    if (inFence) {
      return line;
    }

    return line.replace(/^(\s*)#{2,6}\s+(.+?)\s*$/, '$1**$2**');
  }).join('\n');
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

export function appendMarkdownPreviewLinks(
  reply: string,
  outputLines: string[],
  preview?: FeishuMessageHandlerDeps['markdownPreview'],
): string {
  if (!reply.trim() || !preview) {
    return reply;
  }

  const links = createMarkdownPreviewLinks(extractMarkdownArtifactPaths(outputLines), {
    baseUrl: preview.baseUrl,
    workspaceRoot: preview.workspaceRoot,
  });
  if (links.length === 0) {
    return reply;
  }

  return [
    reply.trimEnd(),
    '',
    '**Markdown 在线预览**',
    ...links.map(link => `- [${link.title}](${link.url})`),
  ].join('\n');
}

export function extractMarkdownArtifactPaths(outputLines: string[]): string[] {
  return extractArtifactPaths(outputLines).filter(path => /\.(md|markdown)$/i.test(path));
}

export function extractArtifactPaths(outputLines: string[]): string[] {
  const paths: string[] = [];
  let collecting = false;

  for (const rawLine of outputLines) {
    const line = rawLine.trim();
    if (/^→\s+已记录\s+\d+\s+个任务产物/.test(line)) {
      collecting = true;
      continue;
    }

    if (!collecting) {
      continue;
    }

    if (!line || line.startsWith('┌') || line.startsWith('→ ') || line.startsWith('✓ ')) {
      collecting = false;
      continue;
    }

    const artifactPath = line.match(/^-\s+(.+)$/)?.[1]?.trim()
      ?? line.match(/^\s*-\s+(.+)$/)?.[1]?.trim();
    if (artifactPath) {
      paths.push(artifactPath);
    }
  }

  return Array.from(new Set(paths));
}

async function sendArtifactFilesToFeishu(
  chatId: string,
  outputLines: string[],
  deps: FeishuMessageHandlerDeps,
): Promise<void> {
  const artifactPaths = extractArtifactPaths(outputLines)
    .filter(path => existsSync(path) && statSync(path).isFile());
  if (artifactPaths.length === 0) {
    return;
  }
  if (!deps.client.uploadFile || !deps.client.sendFileToChat) {
    deps.session.appendSystemMessage('⚠️ 飞书任务产物同步跳过: 当前客户端不支持文件上传');
    return;
  }

  await deps.client.sendMarkdownCardToChat(chatId, [
    '**任务产物已同步到飞书**',
    ...artifactPaths.map(path => `- ${basename(path)}`),
  ].join('\n'));

  for (const artifactPath of artifactPaths) {
    try {
      const fileKey = await deps.client.uploadFile(artifactPath);
      await deps.client.sendFileToChat(chatId, fileKey);
    } catch (error) {
      deps.session.appendSystemMessage(`⚠️ 飞书任务产物同步失败: ${artifactPath}: ${(error as Error).message}`);
      await deps.client.sendMarkdownCardToChat(chatId, `⚠️ 任务产物同步失败：${basename(artifactPath)}`);
    }
  }
}

function formatFeishuPendingReply(outputLines: string[]): string {
  const queuedLine = outputLines
    .map(line => line.trim())
    .find(line => /^→\s*任务\s+#task_[^\s]+\s+已进入待执行队列$/.test(line));
  if (!queuedLine) {
    return '';
  }

  const taskId = queuedLine.match(/#task_[^\s]+/)?.[0];
  return taskId
    ? `任务 ${taskId} 已进入待执行队列，等待当前任务完成后会继续执行。`
    : '任务已进入待执行队列，等待当前任务完成后会继续执行。';
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

export function formatFeishuProgressReply(outputLines: string[]): string {
  return extractFeishuProgressSummary(outputLines);
}

export function formatFeishuStreamingProgressReplies(
  outputLines: string[],
  sentSteps = new Set<string>(),
): string[] {
  const replies: string[] = [];
  for (const rawLine of outputLines) {
    const step = extractFeishuProgressStep(rawLine);
    if (!step || sentSteps.has(step)) {
      continue;
    }
    sentSteps.add(step);
    replies.push(`**处理步骤**\n${step}`);
  }
  return replies;
}

function extractFeishuProgressSummary(outputLines: string[]): string {
  const steps: string[] = [];
  const seen = new Set<string>();
  const addStep = (step: string) => {
    if (!seen.has(step)) {
      seen.add(step);
      steps.push(step);
    }
  };

  for (const rawLine of outputLines) {
    const step = extractFeishuProgressStep(rawLine);
    if (step) {
      addStep(step);
    }
  }

  return steps.length > 0
    ? ['**处理步骤**', ...steps].join('\n')
    : '';
}

function extractFeishuProgressStep(rawLine: string): string | null {
  const line = rawLine.trim();
  if (!line) {
    return null;
  }

  const taskCreated = line.match(/^任务\s+(#task_[^\s]+)\s+已创建：(.+)$/);
  if (taskCreated) {
    return `→ 任务 ${taskCreated[1]} 已创建：${taskCreated[2]}`;
  }

  const contextStep = normalizeFeishuProgressContextStep(line);
  if (contextStep) {
    return contextStep;
  }

  if (/^→\s+派发给\s+[^.。]+[.。]{3}$/.test(line)) {
    return line;
  }

  if (/^→\s+正在执行任务\s+#task_[^\s]+[.。]{3}$/.test(line)) {
    return line;
  }

  if (/^✓\s+任务完成/.test(line)) {
    return line;
  }

  return null;
}

function normalizeFeishuProgressContextStep(line: string): string | null {
  const normalized = line.replace(/^\[/, '【').replace(/\]$/, '】');
  if (
    normalized === '【提取最近历史记录上下文】'
    || normalized === '【构建执行上下文】'
    || normalized === '【执行上下文准备完成】'
  ) {
    return normalized;
  }
  return null;
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

async function defaultPostForm(
  url: string,
  form: FormData,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
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
