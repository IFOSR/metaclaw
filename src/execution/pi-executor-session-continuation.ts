import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorAttemptRuntimeRecord } from '../storage/executor-attempt-runtime-repo.js';

export interface PiExecutorSessionIdentity {
  taskId: string;
  generationId: string;
  subtaskId: string;
  agentClassName: string;
  runtimeBindingId: string;
  runtimeDriver: string;
  runtimeConfigDigest: string;
  projectId: string;
  workspaceId: string;
  workspaceRoot: string;
  workspaceBranch: string;
  workspaceHead: string;
  workspaceHeadCompatible?: boolean;
}

export type PiExecutorSessionResolution =
  | { kind: 'resume'; locator: string; nativeSessionId: string; sessionChainId: string }
  | { kind: 'fresh'; reason: string }
  | { kind: 'blocked'; reason: string };

export async function resolvePiExecutorSession(input: {
  source: ExecutorAttemptRuntimeRecord | null;
  expected: PiExecutorSessionIdentity;
}): Promise<PiExecutorSessionResolution> {
  return resolvePiExecutorSessionSync(input);
}

export function resolvePiExecutorSessionSync(input: {
  source: ExecutorAttemptRuntimeRecord | null;
  expected: PiExecutorSessionIdentity;
}): PiExecutorSessionResolution {
  const source = input.source;
  if (
    !source?.sessionLocator
    || !source.nativeSessionId
    || !source.sessionChainId
    || source.sessionState !== 'confirmed'
  ) {
    return { kind: 'fresh', reason: 'source attempt has no confirmed native Pi session' };
  }
  if (
    source.taskId !== input.expected.taskId
    || source.generationId !== input.expected.generationId
    || source.subtaskId !== input.expected.subtaskId
    || source.agentClassName !== input.expected.agentClassName
  ) {
    return { kind: 'blocked', reason: 'Pi session ownership does not match the authorized attempt' };
  }
  if (
    source.runtimeBindingId !== input.expected.runtimeBindingId
    || source.runtimeDriver !== input.expected.runtimeDriver
    || source.runtimeConfigDigest !== input.expected.runtimeConfigDigest
  ) {
    return { kind: 'fresh', reason: 'Pi session Runtime binding is incompatible' };
  }
  if (
    source.projectId !== input.expected.projectId
    || source.workspaceId !== input.expected.workspaceId
    || source.workspaceRoot !== input.expected.workspaceRoot
    || source.workspaceBranch !== input.expected.workspaceBranch
    || (
      source.workspaceHead !== input.expected.workspaceHead
      && input.expected.workspaceHeadCompatible !== true
    )
  ) {
    return { kind: 'blocked', reason: 'Pi session workspace identity does not match the persistent worktree' };
  }
  if (source.sessionActive) {
    return { kind: 'blocked', reason: 'Pi session chain still has an active writer' };
  }
  if (source.recoverySafety === 'external_non_idempotent' && !source.externalIdempotencyKey) {
    return { kind: 'blocked', reason: 'Pi session cannot prove an external side effect is safe to retry' };
  }
  let persisted: string | null = null;
  try {
    persisted = readFileSync(source.sessionLocator, 'utf8');
  } catch {
    // A missing locator is a recovery fact for Kernel, not an Adapter retry trigger.
  }
  if (!persisted) return { kind: 'fresh', reason: 'persisted Pi session locator is missing' };
  const header = parsePiSessionHeader(persisted);
  if (!header || header.id !== source.nativeSessionId) {
    return { kind: 'fresh', reason: 'persisted Pi session header is missing, damaged, or mismatched' };
  }
  return {
    kind: 'resume',
    locator: source.sessionLocator,
    nativeSessionId: header.id,
    sessionChainId: source.sessionChainId,
  };
}

export function createPiExecutorSessionLocator(
  root: string,
  identity: Pick<PiExecutorSessionIdentity, 'taskId' | 'generationId' | 'subtaskId' | 'agentClassName'>,
  sessionChainId: string,
): string {
  return join(
    root,
    `task-${pathSegment(identity.taskId)}`,
    `generation-${pathSegment(identity.generationId)}`,
    `subtask-${pathSegment(identity.subtaskId)}`,
    `agent-${pathSegment(identity.agentClassName)}`,
    `chain-${pathSegment(sessionChainId)}`,
    'session.jsonl',
  );
}

function parsePiSessionHeader(content: string): { id: string } | null {
  let header: { id: string } | null = null;
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!header && (
        typeof value === 'object'
        && value !== null
        && 'type' in value
        && value.type === 'session'
        && 'id' in value
        && typeof value.id === 'string'
        && value.id.length > 0
      )) header = { id: value.id };
    } catch {
      return null;
    }
  }
  return header;
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}
