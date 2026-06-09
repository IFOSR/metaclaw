export interface FeishuQrRegistrationResult {
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
  userOpenId?: string;
  botName?: string;
  botOpenId?: string;
}

interface FeishuOnboardingDeps {
  postForm?: (url: string, body: URLSearchParams) => Promise<unknown>;
  postJson?: (url: string, body: Record<string, unknown>, headers?: Record<string, string>) => Promise<unknown>;
  getJson?: (url: string, headers?: Record<string, string>) => Promise<unknown>;
  renderQr?: (url: string) => void;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

interface RegisterFeishuBotByQrOptions {
  initialDomain?: 'feishu' | 'lark';
  timeoutMs?: number;
  deps?: FeishuOnboardingDeps;
}

const REGISTRATION_PATH = '/oauth/v1/app/registration';
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export async function registerFeishuBotByQr(
  options: RegisterFeishuBotByQrOptions = {},
): Promise<FeishuQrRegistrationResult | null> {
  const domain = options.initialDomain ?? 'feishu';
  const deps = options.deps ?? {};
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await initRegistration(domain, deps);
  const begin = await beginRegistration(domain, deps);
  const qrUrl = appendQrSource(begin.qrUrl);
  deps.renderQr?.(qrUrl);
  deps.log?.(`请用 ${domain === 'lark' ? 'Lark' : '飞书'} 手机端扫码，或打开 URL: ${qrUrl}`);
  const result = await pollRegistration({
    deviceCode: begin.deviceCode,
    intervalMs: begin.intervalMs,
    expireInMs: Math.min(begin.expireInMs, timeoutMs),
    initialDomain: domain,
    deps,
  });
  if (!result) {
    return null;
  }
  const botInfo = await probeFeishuBot({
    appId: result.appId,
    appSecret: result.appSecret,
    domain: result.domain,
    deps,
  });
  return {
    ...result,
    ...(botInfo?.botName ? { botName: botInfo.botName } : {}),
    ...(botInfo?.botOpenId ? { botOpenId: botInfo.botOpenId } : {}),
  };
}

async function initRegistration(domain: 'feishu' | 'lark', deps: FeishuOnboardingDeps): Promise<void> {
  const payload = await postRegistration(domain, new URLSearchParams({ action: 'init' }), deps);
  const methods = Array.isArray(payload.supported_auth_methods)
    ? payload.supported_auth_methods
    : [];
  if (!methods.includes('client_secret')) {
    throw new Error(`飞书/Lark 注册环境不支持 client_secret 授权。supported_auth_methods=${methods.join(',')}`);
  }
}

async function beginRegistration(domain: 'feishu' | 'lark', deps: FeishuOnboardingDeps): Promise<{
  deviceCode: string;
  qrUrl: string;
  userCode: string;
  intervalMs: number;
  expireInMs: number;
}> {
  const payload = await postRegistration(domain, new URLSearchParams({
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  }), deps);
  const deviceCode = stringValue(payload.device_code);
  const qrUrl = stringValue(payload.verification_uri_complete);
  if (!deviceCode || !qrUrl) {
    throw new Error('飞书/Lark 注册未返回 device_code 或 verification_uri_complete');
  }
  return {
    deviceCode,
    qrUrl,
    userCode: stringValue(payload.user_code),
    intervalMs: Math.max(numberValue(payload.interval, 5) * 1000, 1000),
    expireInMs: Math.max(numberValue(payload.expire_in, 600) * 1000, 1000),
  };
}

async function pollRegistration(input: {
  deviceCode: string;
  intervalMs: number;
  expireInMs: number;
  initialDomain: 'feishu' | 'lark';
  deps: FeishuOnboardingDeps;
}): Promise<Omit<FeishuQrRegistrationResult, 'botName' | 'botOpenId'> | null> {
  const nowMs = input.deps.nowMs ?? (() => Date.now());
  const sleep = input.deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = nowMs() + input.expireInMs;
  let domain = input.initialDomain;

  while (nowMs() < deadline) {
    const payload: Record<string, unknown> = await postRegistration(domain, new URLSearchParams({
      action: 'poll',
      device_code: input.deviceCode,
      tp: 'ob_app',
    }), input.deps).catch(error => {
      input.deps.log?.(`飞书/Lark 注册轮询失败，继续等待: ${(error as Error).message}`);
      return {};
    });
    const userInfo = objectValue(payload.user_info);
    const tenantBrand = stringValue(userInfo.tenant_brand);
    if (tenantBrand === 'lark') {
      domain = 'lark';
    }

    const appId = stringValue(payload.client_id);
    const appSecret = stringValue(payload.client_secret);
    if (appId && appSecret) {
      return {
        appId,
        appSecret,
        domain,
        ...(stringValue(userInfo.open_id) ? { userOpenId: stringValue(userInfo.open_id) } : {}),
      };
    }

    const error = stringValue(payload.error);
    if (error === 'access_denied' || error === 'expired_token') {
      return null;
    }
    await sleep(input.intervalMs);
  }
  return null;
}

export async function probeFeishuBot(input: {
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
  deps?: FeishuOnboardingDeps;
}): Promise<{ botName?: string; botOpenId?: string } | null> {
  const deps = input.deps ?? {};
  const tokenPayload = await (deps.postJson ?? defaultPostJson)(
    `${openBaseUrl(input.domain)}/open-apis/auth/v3/tenant_access_token/internal`,
    { app_id: input.appId, app_secret: input.appSecret },
  );
  const tokenData = objectValue(tokenPayload);
  const token = stringValue(tokenData.tenant_access_token);
  if (!token || numberValue(tokenData.code, 0) !== 0) {
    return null;
  }
  const botPayload = await (deps.getJson ?? defaultGetJson)(
    `${openBaseUrl(input.domain)}/open-apis/bot/v3/info`,
    { authorization: `Bearer ${token}` },
  );
  const botData = objectValue(botPayload);
  if (numberValue(botData.code, 0) !== 0) {
    return null;
  }
  const directBot = objectValue(botData.bot);
  const dataBot = objectValue(objectValue(botData.data).bot);
  const bot = Object.keys(directBot).length > 0 ? directBot : dataBot;
  return {
    ...(stringValue(bot.app_name) || stringValue(bot.bot_name)
      ? { botName: stringValue(bot.app_name) || stringValue(bot.bot_name) }
      : {}),
    ...(stringValue(bot.open_id) ? { botOpenId: stringValue(bot.open_id) } : {}),
  };
}

async function postRegistration(
  domain: 'feishu' | 'lark',
  body: URLSearchParams,
  deps: FeishuOnboardingDeps,
): Promise<Record<string, unknown>> {
  const response = await (deps.postForm ?? defaultPostForm)(`${accountsBaseUrl(domain)}${REGISTRATION_PATH}`, body);
  return objectValue(response);
}

function appendQrSource(qrUrl: string): string {
  return `${qrUrl}${qrUrl.includes('?') ? '&' : '?'}from=metaclaw&tp=metaclaw`;
}

function accountsBaseUrl(domain: 'feishu' | 'lark'): string {
  return domain === 'lark' ? 'https://accounts.larksuite.com' : 'https://accounts.feishu.cn';
}

function openBaseUrl(domain: 'feishu' | 'lark'): string {
  return domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

async function defaultPostForm(url: string, body: URLSearchParams): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  return await response.json();
}

async function defaultPostJson(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return await response.json();
}

async function defaultGetJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    headers,
  });
  return await response.json();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
