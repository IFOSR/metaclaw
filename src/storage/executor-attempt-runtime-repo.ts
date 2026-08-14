import type Database from 'better-sqlite3';
import type { KernelRecoverySafety } from '../kernel/control-kernel.js';

export interface ExecutorAttemptRuntimeRecord {
  attemptId: string;
  sourceAttemptId: string | null;
  continuationToken: string | null;
  workspaceRoot: string | null;
  workspaceBaseline: Record<string, unknown>;
  workspaceDelta: Record<string, unknown>;
  progress: Record<string, unknown>;
  recoverySafety: KernelRecoverySafety;
  externalIdempotencyKey: string | null;
  taskId: string | null;
  generationId: string | null;
  subtaskId: string | null;
  agentClassName: string | null;
  runtimeBindingId: string | null;
  runtimeDriver: string | null;
  runtimeConfigDigest: string | null;
  projectId: string | null;
  workspaceId: string | null;
  workspaceBranch: string | null;
  workspaceHead: string | null;
  sessionChainId: string | null;
  sessionLocator: string | null;
  nativeSessionId: string | null;
  sessionState: 'pinned' | 'confirmed' | 'unavailable' | 'poisoned' | null;
  sessionActive: boolean;
  sessionError: string | null;
  sessionPinnedAt: string | null;
  sessionConfirmedAt: string | null;
  sessionLastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RuntimeRow {
  attempt_id: string;
  source_attempt_id: string | null;
  continuation_token: string | null;
  workspace_root: string | null;
  workspace_baseline_json: string;
  workspace_delta_json: string;
  progress_json: string;
  recovery_safety: KernelRecoverySafety;
  external_idempotency_key: string | null;
  task_id: string | null;
  generation_id: string | null;
  subtask_id: string | null;
  agent_class_name: string | null;
  runtime_binding_id: string | null;
  runtime_driver: string | null;
  runtime_config_digest: string | null;
  project_id: string | null;
  workspace_id: string | null;
  workspace_branch: string | null;
  workspace_head: string | null;
  session_chain_id: string | null;
  session_locator: string | null;
  native_session_id: string | null;
  session_state: 'pinned' | 'confirmed' | 'unavailable' | 'poisoned' | null;
  session_active: 0 | 1;
  session_error: string | null;
  session_pinned_at: string | null;
  session_confirmed_at: string | null;
  session_last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export class ExecutorAttemptRuntimeRepo {
  constructor(private readonly db: Database.Database) {}

  start(input: {
    attemptId: string;
    sourceAttemptId: string | null;
    workspaceRoot: string | null;
    workspaceBaseline?: Record<string, unknown>;
    recoverySafety: KernelRecoverySafety;
    externalIdempotencyKey?: string | null;
    now: string;
  }): ExecutorAttemptRuntimeRecord {
    this.db.prepare(`
      INSERT INTO executor_attempt_runtime (
        attempt_id, source_attempt_id, continuation_token, workspace_root,
        workspace_baseline_json, workspace_delta_json, progress_json,
        recovery_safety, external_idempotency_key, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, '{}', '{}', ?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO NOTHING
    `).run(
      input.attemptId,
      input.sourceAttemptId,
      input.workspaceRoot,
      JSON.stringify(input.workspaceBaseline ?? {}),
      input.recoverySafety,
      input.externalIdempotencyKey ?? null,
      input.now,
      input.now,
    );
    return this.find(input.attemptId)!;
  }

  recordContinuationToken(attemptId: string, token: string, now: string): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime
      SET continuation_token = ?, updated_at = ?
      WHERE attempt_id = ? AND (continuation_token IS NULL OR continuation_token = ?)
    `).run(token, now, attemptId, token);
  }

  pinSession(attemptId: string, input: {
    taskId: string;
    generationId: string;
    subtaskId: string;
    agentClassName: string;
    runtimeBindingId: string;
    runtimeDriver: string;
    runtimeConfigDigest: string;
    projectId: string;
    workspaceId: string;
    workspaceBranch: string;
    workspaceHead: string;
    sessionChainId: string;
    sessionLocator: string;
    now: string;
  }): void {
    const result = this.db.prepare(`
      UPDATE executor_attempt_runtime
      SET task_id = ?, generation_id = ?, subtask_id = ?, agent_class_name = ?,
          runtime_binding_id = ?, runtime_driver = ?, runtime_config_digest = ?,
          project_id = ?, workspace_id = ?, workspace_branch = ?, workspace_head = ?,
          session_chain_id = ?, session_locator = ?, session_state = 'pinned',
          session_active = 0, session_error = NULL, session_pinned_at = ?,
          session_confirmed_at = NULL, session_last_used_at = ?, updated_at = ?
      WHERE attempt_id = ? AND session_state IS NULL
    `).run(
      input.taskId,
      input.generationId,
      input.subtaskId,
      input.agentClassName,
      input.runtimeBindingId,
      input.runtimeDriver,
      input.runtimeConfigDigest,
      input.projectId,
      input.workspaceId,
      input.workspaceBranch,
      input.workspaceHead,
      input.sessionChainId,
      input.sessionLocator,
      input.now,
      input.now,
      input.now,
      attemptId,
    );
    if (result.changes !== 1) throw new Error(`attempt session is already pinned or missing: ${attemptId}`);
  }

  activateSession(attemptId: string, now: string): void {
    try {
      const result = this.db.prepare(`
        UPDATE executor_attempt_runtime
        SET session_active = 1, session_last_used_at = ?, updated_at = ?
        WHERE attempt_id = ?
          AND session_locator IS NOT NULL
          AND session_state IN ('pinned', 'confirmed')
          AND session_active = 0
      `).run(now, now, attemptId);
      if (result.changes !== 1) throw new Error(`attempt session cannot become active: ${attemptId}`);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/u.test(error.message)) {
        throw new Error(`session locator already has an active writer for attempt ${attemptId}`);
      }
      throw error;
    }
  }

  confirmSession(attemptId: string, input: {
    locator: string;
    nativeSessionId: string;
    now: string;
  }): void {
    const result = this.db.prepare(`
      UPDATE executor_attempt_runtime
      SET native_session_id = ?, session_state = 'confirmed', session_error = NULL,
          session_confirmed_at = COALESCE(session_confirmed_at, ?),
          session_last_used_at = ?, continuation_token = ?, updated_at = ?
      WHERE attempt_id = ? AND session_locator = ? AND session_active = 1
        AND session_state IN ('pinned', 'confirmed')
    `).run(
      input.nativeSessionId,
      input.now,
      input.now,
      input.locator,
      input.now,
      attemptId,
      input.locator,
    );
    if (result.changes !== 1) throw new Error(`attempt session confirmation does not match its pin: ${attemptId}`);
  }

  markSessionUnavailable(
    attemptId: string,
    reason: string,
    now: string,
    poisoned = false,
  ): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime
      SET session_state = ?, session_active = 0, session_error = ?,
          session_last_used_at = ?, updated_at = ?
      WHERE attempt_id = ? AND session_state IS NOT NULL
    `).run(poisoned ? 'poisoned' : 'unavailable', reason.slice(0, 2_000), now, now, attemptId);
  }

  releaseSession(attemptId: string, now: string): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime
      SET session_active = 0, session_last_used_at = ?, updated_at = ?
      WHERE attempt_id = ? AND session_active = 1
    `).run(now, now, attemptId);
  }

  recordProgress(attemptId: string, progress: Record<string, unknown>, now: string): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime SET progress_json = ?, updated_at = ? WHERE attempt_id = ?
    `).run(JSON.stringify(progress), now, attemptId);
  }

  recordWorkspaceDelta(attemptId: string, delta: object, now: string): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime SET workspace_delta_json = ?, updated_at = ? WHERE attempt_id = ?
    `).run(JSON.stringify(delta), now, attemptId);
  }

  find(attemptId: string): ExecutorAttemptRuntimeRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM executor_attempt_runtime WHERE attempt_id = ?
    `).get(attemptId) as RuntimeRow | undefined;
    return row ? rowToRecord(row) : null;
  }
}

function rowToRecord(row: RuntimeRow): ExecutorAttemptRuntimeRecord {
  return {
    attemptId: row.attempt_id,
    sourceAttemptId: row.source_attempt_id,
    continuationToken: row.continuation_token,
    workspaceRoot: row.workspace_root,
    workspaceBaseline: JSON.parse(row.workspace_baseline_json) as Record<string, unknown>,
    workspaceDelta: JSON.parse(row.workspace_delta_json) as Record<string, unknown>,
    progress: JSON.parse(row.progress_json) as Record<string, unknown>,
    recoverySafety: row.recovery_safety,
    externalIdempotencyKey: row.external_idempotency_key,
    taskId: row.task_id,
    generationId: row.generation_id,
    subtaskId: row.subtask_id,
    agentClassName: row.agent_class_name,
    runtimeBindingId: row.runtime_binding_id,
    runtimeDriver: row.runtime_driver,
    runtimeConfigDigest: row.runtime_config_digest,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    workspaceBranch: row.workspace_branch,
    workspaceHead: row.workspace_head,
    sessionChainId: row.session_chain_id,
    sessionLocator: row.session_locator,
    nativeSessionId: row.native_session_id,
    sessionState: row.session_state,
    sessionActive: row.session_active === 1,
    sessionError: row.session_error,
    sessionPinnedAt: row.session_pinned_at,
    sessionConfirmedAt: row.session_confirmed_at,
    sessionLastUsedAt: row.session_last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
