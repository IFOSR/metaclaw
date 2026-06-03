const EXECUTOR_NOISE_PATTERNS = [
  /^OpenAI Codex\b/i,
  /^Claude\b/i,
  /^Reading additional input from stdin/i,
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

const EXECUTOR_WARNING_PATTERNS = [
  /^WARNING:\s*failed to clean up stale arg0 temp dirs:/i,
];

export function formatExecutorError(raw?: string): string | undefined {
  if (!raw) return undefined;

  const normalized = raw.trim();
  if (!normalized) return undefined;

  if (isNetworkFailure(normalized)) {
    return '执行器网络连接失败，请检查网络或代理配置';
  }

  if (/executor idle timeout/i.test(normalized)) {
    return '执行器空闲超时，长时间无输出或状态变化，请检查执行器是否卡住';
  }

  if (/executor max duration exceeded/i.test(normalized)) {
    return '执行器历史总时长超限，请升级执行器配置并重试';
  }

  if (/(timed out|timeout)/i.test(normalized)) {
    return '执行器调用超时';
  }

  const lines = normalized
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const meaningfulLine = lines.find(line =>
    !EXECUTOR_NOISE_PATTERNS.some(pattern => pattern.test(line))
    && !EXECUTOR_WARNING_PATTERNS.some(pattern => pattern.test(line)),
  );

  if (meaningfulLine) {
    if (isPermissionFailure(meaningfulLine)) {
      return '执行器权限受限，请确认已授予所需目录访问权限后重试';
    }
    return meaningfulLine;
  }

  if (lines.some(line => isPermissionFailure(line))) {
    return '执行器权限受限，请确认已授予所需目录访问权限后重试';
  }

  return normalized.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? undefined;
}

export function isRecoverableExecutorFailure(raw?: string): boolean {
  if (!raw) return false;
  return isNetworkFailure(raw)
    || /(executor idle timeout|executor max duration exceeded|timed out|timeout|执行器调用超时|执行器空闲超时|执行器历史总时长超限)/i.test(raw)
    || isPermissionFailure(raw);
}

export function formatExecutorProgress(raw?: string): string | undefined {
  if (!raw) return undefined;

  const normalized = stripExecutorLogPrefix(raw.trim());
  if (!normalized) return undefined;

  if (EXECUTOR_NOISE_PATTERNS.some(pattern => pattern.test(normalized))) {
    return undefined;
  }

  if (EXECUTOR_WARNING_PATTERNS.some(pattern => pattern.test(normalized))) {
    return undefined;
  }

  if (isInternalExecutorProgressNoise(normalized)) {
    return undefined;
  }

  if (/^(thinking|reasoning|analyzing|chain of thought)/i.test(normalized)) {
    return '执行器正在分析问题';
  }

  if (isNetworkFailure(normalized)) {
    return '执行器网络连接异常，正在重试';
  }

  return normalized;
}

function stripExecutorLogPrefix(raw: string): string {
  return raw.replace(/^\[[^\]]+\]\s*/, '').trim();
}

function isInternalExecutorProgressNoise(raw: string): boolean {
  return [
    /^exec$/i,
    /^succeeded in \d+(?:\.\d+)?(?:ms|s):?$/i,
    /^failed in \d+(?:\.\d+)?(?:ms|s):?$/i,
    /^\/(?:home|tmp|var|opt|usr|mnt|Volumes)\b/,
    /^[A-Za-z]:\\/,
    /^\/bin\/(?:bash|sh)\b/i,
    /(?:^|\s)(?:find|rg|grep|ls|cat|sed|awk)\s+\/(?:home|tmp|var|opt|usr|mnt|Volumes)\b/i,
    /\bmetaclaw-tasks\/task_[A-Za-z0-9_-]+/,
  ].some(pattern => pattern.test(raw));
}

function isNetworkFailure(raw: string): boolean {
  return /failed to lookup address information|failed to connect to websocket|reconnecting\.\.\.|network is unreachable|temporary failure in name resolution|执行器网络连接失败/i.test(raw);
}

export function isPermissionFailure(raw: string): boolean {
  return /permission denied|operation not permitted|access is denied|not authorized|执行器权限受限/i.test(raw);
}
