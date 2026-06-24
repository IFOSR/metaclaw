import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, resolve } from 'path';

export interface InlineResourceMatch {
  raw: string;
  resolvedPath: string;
}

export function extractInlineResourceMatches(input: string, cwd = process.cwd()): InlineResourceMatch[] {
  const matches: InlineResourceMatch[] = [];
  const seen = new Set<string>();
  const quotedPattern = /(["'])(.+?)\1/g;

  for (const match of input.matchAll(quotedPattern)) {
    const raw = match[2]?.trim();
    if (!raw) {
      continue;
    }
    maybePushInlineResource(raw, raw, cwd, seen, matches);
  }

  const tokens = input.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const cleaned = token.replace(/^[,，。！？；：（）()\[\]{}"']+|[,，。！？；：（）()\[\]{}"']+$/g, '');
    if (!cleaned) {
      continue;
    }
    maybePushInlineResource(cleaned, cleaned, cwd, seen, matches);
  }

  return matches;
}

export function stripInlineResourceMatches(input: string, matches: InlineResourceMatch[]): string {
  let cleaned = input;
  for (const match of matches) {
    cleaned = cleaned.replace(match.raw, ' ');
  }

  return cleaned
    .replace(/\s+(和|以及)\s+/g, ' ')
    .replace(/^(基于|根据|结合)\s+(整理|分析|输出|生成|总结|撰写|提炼|归纳|制作)/, '$2')
    .replace(/\s+/g, ' ')
    .replace(/\s*([，。,.;；：！？])/g, '$1')
    .trim();
}

function maybePushInlineResource(
  raw: string,
  candidate: string,
  cwd: string,
  seen: Set<string>,
  matches: InlineResourceMatch[],
): void {
  if (looksLikeUrl(candidate)) {
    if (seen.has(candidate)) {
      return;
    }

    seen.add(candidate);
    matches.push({ raw, resolvedPath: candidate });
    return;
  }

  if (!looksLikeLocalPath(candidate)) {
    return;
  }

  const resolvedPath = resolveInlinePath(candidate, cwd);
  if (!resolvedPath || seen.has(resolvedPath)) {
    return;
  }

  try {
    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
      return;
    }
  } catch {
    return;
  }

  seen.add(resolvedPath);
  matches.push({ raw, resolvedPath });
}

function looksLikeLocalPath(candidate: string): boolean {
  return candidate.startsWith('/')
    || candidate.startsWith('./')
    || candidate.startsWith('../')
    || candidate.startsWith('~/')
    || candidate.includes('/')
    || /^[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8}$/.test(candidate);
}

function looksLikeUrl(candidate: string): boolean {
  return /^https?:\/\/\S+$/i.test(candidate);
}

function resolveInlinePath(candidate: string, cwd: string): string | null {
  if (candidate.startsWith('~/')) {
    return resolve(homedir(), candidate.slice(2));
  }

  if (isAbsolute(candidate)) {
    return candidate;
  }

  return resolve(cwd, candidate);
}
