import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePiExecutorSession } from '../../src/execution/pi-executor-session-continuation.js';
import type { ExecutorAttemptRuntimeRecord } from '../../src/storage/executor-attempt-runtime-repo.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('resolvePiExecutorSession', () => {
  it('resumes a confirmed compatible session in the same workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-pi-session-resolution-'));
    cleanup.push(root);
    const locator = join(root, 'session.jsonl');
    mkdirSync(root, { recursive: true });
    writeFileSync(locator, [
      '{"type":"session","version":3,"id":"native-session-1","cwd":"/runtime/worktree"}',
      '{"type":"message","id":"message-1"}',
    ].join('\n'));

    await expect(resolvePiExecutorSession({
      source: sourceRecord(locator),
      expected: {
        taskId: 'task_1', generationId: 'generation_1', subtaskId: 'subtask_1',
        agentClassName: 'pi-agent', runtimeBindingId: 'pi-agent', runtimeDriver: 'pi',
        runtimeConfigDigest: 'digest-1', projectId: 'project_1', workspaceId: 'workspace_1',
        workspaceRoot: '/runtime/worktree', workspaceBranch: 'anyfusion/task/task_1/subtask/subtask_1',
        workspaceHead: 'abc123',
      },
    })).resolves.toEqual({
      kind: 'resume',
      locator,
      nativeSessionId: 'native-session-1',
      sessionChainId: 'attempt_1',
    });
  });

  it('blocks a session owned by another Subtask instead of silently reusing it', async () => {
    const source = sourceRecord('/runtime/executor-sessions/session.jsonl');
    source.subtaskId = 'subtask_other';

    await expect(resolvePiExecutorSession({
      source,
      expected: expectedIdentity(),
    })).resolves.toEqual({
      kind: 'blocked',
      reason: 'Pi session ownership does not match the authorized attempt',
    });
  });

  it('falls back to fresh facts when the Runtime binding is incompatible', async () => {
    const source = sourceRecord('/runtime/executor-sessions/session.jsonl');
    source.runtimeConfigDigest = 'digest-old';

    await expect(resolvePiExecutorSession({ source, expected: expectedIdentity() }))
      .resolves.toEqual({
        kind: 'fresh',
        reason: 'Pi session Runtime binding is incompatible',
      });
  });

  it('blocks continuation when the persistent worktree identity drifted', async () => {
    const source = sourceRecord('/runtime/executor-sessions/session.jsonl');
    source.workspaceHead = 'stale-head';

    await expect(resolvePiExecutorSession({ source, expected: expectedIdentity() }))
      .resolves.toEqual({
        kind: 'blocked',
        reason: 'Pi session workspace identity does not match the persistent worktree',
      });
  });

  it('falls back when the process exited before confirming the native session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-pi-session-unconfirmed-'));
    cleanup.push(root);
    const locator = join(root, 'session.jsonl');
    writeFileSync(locator, '{"type":"session","version":3,"id":"native-session-1"}\n');
    const source = sourceRecord(locator);
    source.sessionState = 'pinned';
    source.nativeSessionId = null;

    await expect(resolvePiExecutorSession({ source, expected: expectedIdentity() }))
      .resolves.toEqual({
        kind: 'fresh',
        reason: 'source attempt has no confirmed native Pi session',
      });
  });

  it('blocks while another process still owns the same session chain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-pi-session-active-'));
    cleanup.push(root);
    const locator = join(root, 'session.jsonl');
    writeFileSync(locator, '{"type":"session","version":3,"id":"native-session-1"}\n');
    const source = sourceRecord(locator);
    source.sessionActive = true;

    await expect(resolvePiExecutorSession({ source, expected: expectedIdentity() }))
      .resolves.toEqual({
        kind: 'blocked',
        reason: 'Pi session chain still has an active writer',
      });
  });

  it('blocks an uncertain non-idempotent side effect instead of replaying it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-pi-session-side-effect-'));
    cleanup.push(root);
    const locator = join(root, 'session.jsonl');
    writeFileSync(locator, '{"type":"session","version":3,"id":"native-session-1"}\n');
    const source = sourceRecord(locator);
    source.recoverySafety = 'external_non_idempotent';
    source.externalIdempotencyKey = null;

    await expect(resolvePiExecutorSession({ source, expected: expectedIdentity() }))
      .resolves.toEqual({
        kind: 'blocked',
        reason: 'Pi session cannot prove an external side effect is safe to retry',
      });
  });

  it('falls back when the persisted session JSONL is damaged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-pi-session-damaged-'));
    cleanup.push(root);
    const locator = join(root, 'session.jsonl');
    writeFileSync(locator, [
      '{"type":"session","version":3,"id":"native-session-1"}',
      '{"type":"message"',
    ].join('\n'));

    await expect(resolvePiExecutorSession({ source: sourceRecord(locator), expected: expectedIdentity() }))
      .resolves.toEqual({
        kind: 'fresh',
        reason: 'persisted Pi session header is missing, damaged, or mismatched',
      });
  });
});

function expectedIdentity() {
  return {
    taskId: 'task_1', generationId: 'generation_1', subtaskId: 'subtask_1',
    agentClassName: 'pi-agent', runtimeBindingId: 'pi-agent', runtimeDriver: 'pi',
    runtimeConfigDigest: 'digest-1', projectId: 'project_1', workspaceId: 'workspace_1',
    workspaceRoot: '/runtime/worktree', workspaceBranch: 'anyfusion/task/task_1/subtask/subtask_1',
    workspaceHead: 'abc123',
  };
}

function sourceRecord(locator: string): ExecutorAttemptRuntimeRecord {
  return {
    attemptId: 'attempt_1', sourceAttemptId: null, continuationToken: locator,
    workspaceRoot: '/runtime/worktree', workspaceBaseline: {}, workspaceDelta: {}, progress: {},
    recoverySafety: 'workspace_reconcilable', externalIdempotencyKey: null,
    taskId: 'task_1', generationId: 'generation_1', subtaskId: 'subtask_1',
    agentClassName: 'pi-agent', runtimeBindingId: 'pi-agent', runtimeDriver: 'pi',
    runtimeConfigDigest: 'digest-1', projectId: 'project_1', workspaceId: 'workspace_1',
    workspaceBranch: 'anyfusion/task/task_1/subtask/subtask_1', workspaceHead: 'abc123',
    sessionChainId: 'attempt_1', sessionLocator: locator, nativeSessionId: 'native-session-1',
    sessionState: 'confirmed', sessionActive: false, sessionError: null,
    sessionPinnedAt: '2026-08-14T00:00:00.000Z', sessionConfirmedAt: '2026-08-14T00:00:01.000Z',
    sessionLastUsedAt: '2026-08-14T00:00:02.000Z', createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:02.000Z',
  };
}
