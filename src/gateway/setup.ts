import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dump, load } from 'js-yaml';
import { resolve } from 'path';
import { createInterface, type Interface } from 'readline';
import { stdin as input, stdout as output } from 'process';
import { registerFeishuBotByQr, type FeishuQrRegistrationResult } from './feishu-onboarding.js';

type FeishuDomain = 'feishu' | 'lark';
type FeishuConnectionMode = 'websocket' | 'webhook';
type FeishuDmPolicy = 'pairing' | 'allow_all' | 'allowlist';
type FeishuGroupPolicy = 'open' | 'disabled';

interface GatewaySetupDeps {
  registerFeishuBotByQr?: typeof registerFeishuBotByQr;
  prompt?: (question: string, options?: { password?: boolean; defaultValue?: string }) => Promise<string>;
  choose?: (question: string, choices: string[], defaultIndex?: number) => Promise<number>;
  writeLine?: (line?: string) => void;
  close?: () => void;
}

export interface GatewaySetupOptions {
  metaclawDir: string;
  deps?: GatewaySetupDeps;
}

interface FeishuSetupCredentials {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  userOpenId?: string;
  botName?: string;
  botOpenId?: string;
}

export async function runGatewaySetup(options: GatewaySetupOptions): Promise<void> {
  const deps = createSetupDeps(options.deps);
  try {
    deps.writeLine();
    deps.writeLine('─── MetaClaw Gateway Setup ───');
    deps.writeLine();

    const platformIndex = await deps.choose('选择要配置的平台', ['Feishu / Lark'], 0);
    if (platformIndex !== 0) {
      return;
    }

    await setupFeishuGateway(options.metaclawDir, deps);
  } finally {
    deps.close();
  }
}

async function setupFeishuGateway(metaclawDir: string, deps: Required<GatewaySetupDeps>): Promise<void> {
  deps.writeLine('─── Feishu / Lark Setup ───');
  deps.writeLine();

  const methodIndex = await deps.choose('如何配置 Feishu / Lark？', [
    '扫码自动创建 Bot（推荐）',
    '手动输入 App ID / App Secret',
  ], 0);

  let credentials: FeishuSetupCredentials | null = null;
  let usedQr = false;
  if (methodIndex === 0) {
    const result = await deps.registerFeishuBotByQr({
      deps: {
        log: line => deps.writeLine(line),
        renderQr: url => deps.writeLine(`二维码 URL: ${url}`),
      },
    });
    if (result) {
      credentials = normalizeQrResult(result);
      usedQr = true;
    } else {
      deps.writeLine('扫码注册没有完成，继续使用手动配置。');
    }
  }

  if (!credentials) {
    credentials = await promptManualCredentials(deps);
  }

  const connectionMode = usedQr
    ? 'websocket'
    : await promptConnectionMode(deps);
  const dmPolicy = await promptDmPolicy(deps);
  const allowedUsers = dmPolicy === 'allowlist'
    ? await promptAllowedUsers(deps, credentials.userOpenId)
    : [];
  const groupPolicy = await promptGroupPolicy(deps);
  const homeChannel = await deps.prompt('Home chat ID（可选，后续也可在飞书发送 /sethome）', { defaultValue: '' });

  writeFeishuGatewayConfig({
    metaclawDir,
    credentials,
    connectionMode,
    dmPolicy,
    allowedUsers,
    groupPolicy,
    homeChannel,
  });

  deps.writeLine();
  deps.writeLine('Feishu / Lark Gateway 配置完成。');
  deps.writeLine(`App ID: ${credentials.appId}`);
  deps.writeLine(`Domain: ${credentials.domain}`);
  deps.writeLine(`Connection mode: ${connectionMode}`);
  if (credentials.botName) {
    deps.writeLine(`Bot: ${credentials.botName}`);
  }
  deps.writeLine('下一步: metaclaw gateway run');
}

function normalizeQrResult(result: FeishuQrRegistrationResult): FeishuSetupCredentials {
  return {
    appId: result.appId,
    appSecret: result.appSecret,
    domain: result.domain,
    ...(result.userOpenId ? { userOpenId: result.userOpenId } : {}),
    ...(result.botName ? { botName: result.botName } : {}),
    ...(result.botOpenId ? { botOpenId: result.botOpenId } : {}),
  };
}

async function promptManualCredentials(deps: Required<GatewaySetupDeps>): Promise<FeishuSetupCredentials> {
  deps.writeLine('请在飞书开放平台创建应用、启用 Bot，并复制 App ID / App Secret。');
  const appId = await deps.prompt('App ID');
  if (!appId) {
    throw new Error('缺少 Feishu App ID');
  }
  const appSecret = await deps.prompt('App Secret', { password: true });
  if (!appSecret) {
    throw new Error('缺少 Feishu App Secret');
  }
  const domainIndex = await deps.choose('Domain', ['feishu（中国）', 'lark（国际版）'], 0);
  return {
    appId,
    appSecret,
    domain: domainIndex === 1 ? 'lark' : 'feishu',
  };
}

async function promptConnectionMode(deps: Required<GatewaySetupDeps>): Promise<FeishuConnectionMode> {
  const modeIndex = await deps.choose('连接模式', [
    'WebSocket（推荐，无需公网地址）',
    'Webhook（需要公网回调地址）',
  ], 0);
  return modeIndex === 1 ? 'webhook' : 'websocket';
}

async function promptDmPolicy(deps: Required<GatewaySetupDeps>): Promise<FeishuDmPolicy> {
  const index = await deps.choose('私聊 DM 如何授权？', [
    'Pairing approval（推荐）',
    'Allow all',
    'Allowlist',
  ], 0);
  if (index === 1) {
    return 'allow_all';
  }
  if (index === 2) {
    return 'allowlist';
  }
  return 'pairing';
}

async function promptAllowedUsers(deps: Required<GatewaySetupDeps>, defaultOpenId?: string): Promise<string[]> {
  const raw = await deps.prompt('允许的飞书用户 ID（逗号分隔）', { defaultValue: defaultOpenId ?? '' });
  return raw.split(',').map(value => value.trim()).filter(Boolean);
}

async function promptGroupPolicy(deps: Required<GatewaySetupDeps>): Promise<FeishuGroupPolicy> {
  const index = await deps.choose('群聊如何处理？', [
    '只在 @bot 时响应（推荐）',
    '禁用群聊',
  ], 0);
  return index === 1 ? 'disabled' : 'open';
}

function writeFeishuGatewayConfig(input: {
  metaclawDir: string;
  credentials: FeishuSetupCredentials;
  connectionMode: FeishuConnectionMode;
  dmPolicy: FeishuDmPolicy;
  allowedUsers: string[];
  groupPolicy: FeishuGroupPolicy;
  homeChannel: string;
}): void {
  mkdirSync(input.metaclawDir, { recursive: true });
  const configPath = resolve(input.metaclawDir, 'config.yaml');
  const envPath = resolve(input.metaclawDir, '.env');
  const config = readConfigObject(configPath);
  const legacyFeishu = objectValue(objectValue(config.integrations).feishu);
  const existingGatewayFeishu = objectValue(objectValue(objectValue(config.gateway).platforms).feishu);
  const feishuConfig = {
    enabled: true,
    domain: input.credentials.domain,
    connection_mode: input.connectionMode,
    app_id: input.credentials.appId,
    app_secret_env: 'FEISHU_APP_SECRET',
    event_port: numberValue(existingGatewayFeishu.event_port, numberValue(legacyFeishu.event_port, 8787)),
    event_path: stringValue(existingGatewayFeishu.event_path, stringValue(legacyFeishu.event_path, '/feishu/events')),
    verification_token: stringValue(existingGatewayFeishu.verification_token, stringValue(legacyFeishu.verification_token, '')),
    access: {
      dm_policy: input.dmPolicy,
      allowed_users: input.allowedUsers,
      group_policy: input.groupPolicy,
      require_mention: true,
    },
    delivery: {
      final_markdown_mode: 'card',
      fallback_mode: 'post',
      final_file_fallback: true,
    },
    ...(input.homeChannel.trim() ? { home_channel: input.homeChannel.trim() } : {}),
  };

  config.version = numberValue(config.version, 1);
  config.gateway = {
    ...objectValue(config.gateway),
    enabled: true,
    platforms: {
      ...objectValue(objectValue(config.gateway).platforms),
      feishu: feishuConfig,
    },
  };
  const integrations = objectValue(config.integrations);
  delete integrations.feishu;
  if (Object.keys(integrations).length > 0) {
    config.integrations = integrations;
  } else {
    delete config.integrations;
  }

  writeFileSync(configPath, dump(config, { lineWidth: 120 }), 'utf-8');
  writeEnvValues(envPath, {
    FEISHU_APP_SECRET: input.credentials.appSecret,
    FEISHU_DOMAIN: input.credentials.domain,
    FEISHU_CONNECTION_MODE: input.connectionMode,
    FEISHU_ALLOW_ALL_USERS: input.dmPolicy === 'allow_all' ? 'true' : 'false',
    FEISHU_ALLOWED_USERS: input.allowedUsers.join(','),
    FEISHU_GROUP_POLICY: input.groupPolicy,
    ...(input.credentials.botOpenId ? { FEISHU_BOT_OPEN_ID: input.credentials.botOpenId } : {}),
    ...(input.credentials.botName ? { FEISHU_BOT_NAME: input.credentials.botName } : {}),
    ...(input.homeChannel.trim() ? { FEISHU_HOME_CHANNEL: input.homeChannel.trim() } : {}),
  });
}

function readConfigObject(configPath: string): Record<string, any> {
  if (!existsSync(configPath)) {
    return { version: 1 };
  }
  const parsed = load(readFileSync(configPath, 'utf-8'));
  return objectValue(parsed);
}

function writeEnvValues(envPath: string, values: Record<string, string>): void {
  const existingLines = existsSync(envPath)
    ? readFileSync(envPath, 'utf-8').split(/\r?\n/)
    : [];
  const valueMap = new Map(Object.entries(values));
  const written = new Set<string>();
  const lines = existingLines
    .filter((line, index) => index < existingLines.length - 1 || line.trim().length > 0)
    .map(line => {
      const key = line.includes('=') ? line.slice(0, line.indexOf('=')).trim() : '';
      if (!valueMap.has(key)) {
        return line;
      }
      written.add(key);
      return `${key}=${quoteEnvValue(valueMap.get(key) ?? '')}`;
    });
  for (const [key, value] of valueMap) {
    if (!written.has(key)) {
      lines.push(`${key}=${quoteEnvValue(value)}`);
    }
  }
  writeFileSync(envPath, `${lines.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 });
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:-]*$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function createSetupDeps(overrides: GatewaySetupDeps = {}): Required<GatewaySetupDeps> {
  const rl = overrides.prompt || overrides.choose ? null : createInterface({ input, output });
  const prompt = overrides.prompt ?? (async (question, options) => {
    const suffix = options?.defaultValue ? ` (${options.defaultValue})` : '';
    const answer = await askQuestion(rl!, `${question}${suffix}: `);
    return answer.trim() || options?.defaultValue || '';
  });
  return {
    registerFeishuBotByQr: overrides.registerFeishuBotByQr ?? registerFeishuBotByQr,
    prompt,
    choose: overrides.choose ?? (async (question, choices, defaultIndex = 0) => {
      output.write(`${question}\n`);
      choices.forEach((choice, index) => output.write(`  ${index + 1}. ${choice}${index === defaultIndex ? ' (默认)' : ''}\n`));
      const answer = await prompt('选择', { defaultValue: String(defaultIndex + 1) });
      const selected = Number(answer) - 1;
      return Number.isInteger(selected) && selected >= 0 && selected < choices.length ? selected : defaultIndex;
    }),
    writeLine: overrides.writeLine ?? ((line = '') => output.write(`${line}\n`)),
    close: overrides.close ?? (() => rl?.close()),
  };
}

function askQuestion(rl: Interface, question: string): Promise<string> {
  return new Promise(resolveAnswer => {
    rl.question(question, resolveAnswer);
  });
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
