import type Database from 'better-sqlite3';

export interface SessionStateRecord {
  id: string;
  lastFocusedTaskId: string | null;
  lastCompletedTaskId: string | null;
  lastSessionId: string | null;
  updatedAt: string;
}

interface SessionStateRow {
  id: string;
  last_focused_task_id: string | null;
  last_completed_task_id: string | null;
  last_session_id: string | null;
  updated_at: string;
}

const SESSION_STATE_ID = 'global';

function rowToRecord(row: SessionStateRow): SessionStateRecord {
  return {
    id: row.id,
    lastFocusedTaskId: row.last_focused_task_id,
    lastCompletedTaskId: row.last_completed_task_id,
    lastSessionId: row.last_session_id,
    updatedAt: row.updated_at,
  };
}

export class SessionStateRepo {
  constructor(private db: Database.Database) {}

  get(): SessionStateRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM session_state WHERE id = ?'
    ).get(SESSION_STATE_ID) as SessionStateRow | undefined;

    return row ? rowToRecord(row) : null;
  }

  upsert(changes: {
    lastFocusedTaskId?: string | null;
    lastCompletedTaskId?: string | null;
    lastSessionId?: string | null;
  }): SessionStateRecord {
    const existing = this.get();
    const next: SessionStateRecord = {
      id: SESSION_STATE_ID,
      lastFocusedTaskId: changes.lastFocusedTaskId !== undefined
        ? changes.lastFocusedTaskId
        : existing?.lastFocusedTaskId ?? null,
      lastCompletedTaskId: changes.lastCompletedTaskId !== undefined
        ? changes.lastCompletedTaskId
        : existing?.lastCompletedTaskId ?? null,
      lastSessionId: changes.lastSessionId !== undefined
        ? changes.lastSessionId
        : existing?.lastSessionId ?? null,
      updatedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO session_state (
        id,
        last_focused_task_id,
        last_completed_task_id,
        last_session_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_focused_task_id = excluded.last_focused_task_id,
        last_completed_task_id = excluded.last_completed_task_id,
        last_session_id = excluded.last_session_id,
        updated_at = excluded.updated_at
    `).run(
      next.id,
      next.lastFocusedTaskId,
      next.lastCompletedTaskId,
      next.lastSessionId,
      next.updatedAt,
    );

    return next;
  }
}
