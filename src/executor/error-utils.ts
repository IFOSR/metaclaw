const EXECUTOR_NOISE_PATTERNS = [
  /^OpenAI Codex\b/i,
  /^Claude\b/i,
  /^-+$/,
  /^workdir:/i,
  /^model:/i,
  /^provider:/i,
  /^approval:/i,
  /^sandbox:/i,
  /^reasoning effort:/i,
  /^reasoning summaries:/i,
  /^session id:/i,
  /^user$/i,
  /^\[Metaclaw 执行上下文\]$/,
  /^\[系统边界\]/,
  /^模式：/,
  /^任务：/,
  /^目标：/,
  /^当前状态：/,
  /^用户指令：/,
  /^执行要求：/,
  /^- 使用与用户相同的语言回复$/,
];

export function formatExecutorError(raw?: string): string | undefined {
  if (!raw) return undefined;

  const normalized = raw.trim();
  if (!normalized) return undefined;

  if (isNetworkFailure(normalized)) {
    return '执行器网络连接失败，请检查网络或代理配置';
  }

  if (/(timed out|timeout)/i.test(normalized)) {
    return '执行器调用超时';
  }

  const meaningfulLine = normalized
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .find(line => !EXECUTOR_NOISE_PATTERNS.some(pattern => pattern.test(line)));

  if (meaningfulLine) {
    return meaningfulLine;
  }

  return normalized.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? undefined;
}

function isNetworkFailure(raw: string): boolean {
  return /failed to lookup address information|failed to connect to websocket|reconnecting\.\.\.|network is unreachable|temporary failure in name resolution/i.test(raw);
}
