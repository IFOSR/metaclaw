import type Database from 'better-sqlite3';
import type { WorktreeLease } from '../core/types.js';

interface WorktreeLeaseRow {
  id: string;
  worktree_path: string;
  work_unit_id: string;
  task_id: string;
  subtask_id: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  created_at: string;
}

function rowToLease(row: WorktreeLeaseRow): WorktreeLease {
  return {
    id: row.id,
    worktreePath: row.worktree_path,
    workUnitId: row.work_unit_id,
    taskId: row.task_id,
    subtaskId: row.subtask_id,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
    createdAt: row.created_at,
  };
}

export class WorktreeLeaseRepo {
  constructor(private readonly db: Database.Database) {}

  insert(lease: WorktreeLease): void {
    this.db.prepare(`
      INSERT INTO worktree_leases (
        id, worktree_path, work_unit_id, task_id, subtask_id,
        heartbeat_at, expires_at, released_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      lease.id,
      lease.worktreePath,
      lease.workUnitId,
      lease.taskId,
      lease.subtaskId,
      lease.heartbeatAt,
      lease.expiresAt,
      lease.releasedAt,
      lease.createdAt,
    );
  }

  findActiveByPath(worktreePath: string, now = new Date().toISOString()): WorktreeLease | null {
    const row = this.db.prepare(`
      SELECT * FROM worktree_leases
      WHERE worktree_path = ? AND released_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(worktreePath, now) as WorktreeLeaseRow | undefined;
    return row ? rowToLease(row) : null;
  }

  release(id: string): void {
    this.db.prepare('UPDATE worktree_leases SET released_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }
}
