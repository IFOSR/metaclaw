import { existsSync, readFileSync } from 'fs';

export function loadEnvFileIfExists(envPath: string, targetEnv: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    if (!key || targetEnv[key]) {
      continue;
    }
    targetEnv[key] = parseEnvValue(line.slice(separatorIndex + 1).trim());
  }
}

function parseEnvValue(rawValue: string): string {
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"'))
    || (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }
  return rawValue;
}
