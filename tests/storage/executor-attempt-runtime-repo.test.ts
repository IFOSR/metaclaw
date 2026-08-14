import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { ExecutorAttemptRuntimeRepo } from '../../src/storage/executor-attempt-runtime-repo.js';

describe('ExecutorAttemptRuntimeRepo', () => {
  it('persists an early continuation token and bounded recovery facts independently of receipts', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new ExecutorAttemptRuntimeRepo(db);
    const now = '2026-07-21T00:00:00.000Z';
    repo.start({
      attemptId: 'attempt_2', sourceAttemptId: 'attempt_1', workspaceRoot: '/repo',
      workspaceBaseline: { paths: { 'dirty.txt': 'hash-before' } },
      recoverySafety: 'workspace_reconcilable', now,
    });
    repo.recordContinuationToken('attempt_2', '019f-thread', now);
    repo.recordProgress('attempt_2', { text: 'half done' }, now);
    repo.recordWorkspaceDelta('attempt_2', { changed: [{ path: 'new.txt' }] }, now);

    expect(repo.find('attempt_2')).toMatchObject({
      sourceAttemptId: 'attempt_1',
      continuationToken: '019f-thread',
      workspaceBaseline: { paths: { 'dirty.txt': 'hash-before' } },
      workspaceDelta: { changed: [{ path: 'new.txt' }] },
      progress: { text: 'half done' },
      recoverySafety: 'workspace_reconcilable',
    });
  });

  it('pins and confirms one active native session writer with recovery identity', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new ExecutorAttemptRuntimeRepo(db);
    const now = '2026-08-14T00:00:00.000Z';
    repo.start({
      attemptId: 'attempt_1', sourceAttemptId: null, workspaceRoot: '/runtime/worktree',
      recoverySafety: 'workspace_reconcilable', now,
    });
    repo.pinSession('attempt_1', {
      taskId: 'task_1', generationId: 'generation_1', subtaskId: 'subtask_1',
      agentClassName: 'pi-agent', runtimeBindingId: 'pi-agent', runtimeDriver: 'pi',
      runtimeConfigDigest: 'digest-1', projectId: 'project_1', workspaceId: 'workspace_1',
      workspaceBranch: 'anyfusion/task/task_1/subtask/subtask_1', workspaceHead: 'abc123',
      sessionChainId: 'attempt_1', sessionLocator: '/runtime/executor-sessions/session.jsonl', now,
    });
    repo.activateSession('attempt_1', now);
    repo.confirmSession('attempt_1', {
      locator: '/runtime/executor-sessions/session.jsonl',
      nativeSessionId: 'native-session-1',
      now,
    });

    expect(repo.find('attempt_1')).toMatchObject({
      taskId: 'task_1', generationId: 'generation_1', subtaskId: 'subtask_1',
      agentClassName: 'pi-agent', runtimeBindingId: 'pi-agent', runtimeDriver: 'pi',
      runtimeConfigDigest: 'digest-1', projectId: 'project_1', workspaceId: 'workspace_1',
      workspaceBranch: 'anyfusion/task/task_1/subtask/subtask_1', workspaceHead: 'abc123',
      sessionChainId: 'attempt_1', sessionLocator: '/runtime/executor-sessions/session.jsonl',
      nativeSessionId: 'native-session-1', sessionState: 'confirmed', sessionActive: true,
      sessionError: null, sessionPinnedAt: now, sessionConfirmedAt: now, sessionLastUsedAt: now,
    });

    repo.start({
      attemptId: 'attempt_2', sourceAttemptId: 'attempt_1', workspaceRoot: '/runtime/worktree',
      recoverySafety: 'workspace_reconcilable', now,
    });
    repo.pinSession('attempt_2', {
      taskId: 'task_1', generationId: 'generation_1', subtaskId: 'subtask_1',
      agentClassName: 'pi-agent', runtimeBindingId: 'pi-agent', runtimeDriver: 'pi',
      runtimeConfigDigest: 'digest-1', projectId: 'project_1', workspaceId: 'workspace_1',
      workspaceBranch: 'anyfusion/task/task_1/subtask/subtask_1', workspaceHead: 'abc123',
      sessionChainId: 'attempt_1', sessionLocator: '/runtime/executor-sessions/session.jsonl', now,
    });
    expect(() => repo.activateSession('attempt_2', now)).toThrow('already has an active writer');

    repo.start({
      attemptId: 'attempt_other_subtask', sourceAttemptId: null, workspaceRoot: '/runtime/other-worktree',
      recoverySafety: 'workspace_reconcilable', now,
    });
    repo.pinSession('attempt_other_subtask', {
      taskId: 'task_1', generationId: 'generation_1', subtaskId: 'subtask_2',
      agentClassName: 'pi-agent', runtimeBindingId: 'pi-agent', runtimeDriver: 'pi',
      runtimeConfigDigest: 'digest-1', projectId: 'project_1', workspaceId: 'workspace_2',
      workspaceBranch: 'anyfusion/task/task_1/subtask/subtask_2', workspaceHead: 'def456',
      sessionChainId: 'attempt_other_subtask',
      sessionLocator: '/runtime/executor-sessions/other-session.jsonl', now,
    });
    expect(() => repo.activateSession('attempt_other_subtask', now)).not.toThrow();

    repo.releaseSession('attempt_1', now);
    expect(() => repo.activateSession('attempt_2', now)).not.toThrow();
  });
});
