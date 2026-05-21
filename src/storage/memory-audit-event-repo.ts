import type Database from 'better-sqlite3';

export type MemoryAuditAction = 'auto_capture' | 'auto_apply' | 'ask_review' | 'suppress' | 'undo';

interface MemoryAuditEventRow {
  id: string;
  task_id: string | null;
  memory_id: string;
  action: MemoryAuditAction;
  score: number | null;
  reason: string;
  judge_source: string;
  evidence_json: string;
  created_at: string;
}

export interface MemoryAuditEventRecord {
  id: string;
  taskId: string | null;
  memoryId: string;
  action: MemoryAuditAction;
  score: number | null;
  reason: string;
  judgeSource: string;
  evidence: unknown[];
  createdAt: string;
}

function rowToRecord(row: MemoryAuditEventRow): MemoryAuditEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    memoryId: row.memory_id,
    action: row.action,
    score: row.score,
    reason: row.reason,
    judgeSource: row.judge_source,
    evidence: JSON.parse(row.evidence_json),
    createdAt: row.created_at,
  };
}

export class MemoryAuditEventRepo {
  constructor(private db: Database.Database) {}

  insert(record: MemoryAuditEventRecord): void {
    this.db.prepare(`
      INSERT INTO memory_audit_events (
        id, task_id, memory_id, action, score, reason, judge_source, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.taskId,
      record.memoryId,
      record.action,
      record.score,
      record.reason,
      record.judgeSource,
      JSON.stringify(record.evidence),
      record.createdAt,
    );
  }

  findRecent(limit = 20): MemoryAuditEventRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM memory_audit_events ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as MemoryAuditEventRow[];
    return rows.map(rowToRecord);
  }

  findByMemoryId(memoryId: string, limit = 20): MemoryAuditEventRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM memory_audit_events WHERE memory_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(memoryId, limit) as MemoryAuditEventRow[];
    return rows.map(rowToRecord);
  }

  findByAction(action: MemoryAuditAction, limit = 20): MemoryAuditEventRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM memory_audit_events WHERE action = ? ORDER BY created_at DESC LIMIT ?'
    ).all(action, limit) as MemoryAuditEventRow[];
    return rows.map(rowToRecord);
  }

  findApplied(taskId?: string, limit = 20): MemoryAuditEventRecord[] {
    const rows = taskId
      ? this.db.prepare(
        `SELECT * FROM memory_audit_events
         WHERE action = 'auto_apply' AND task_id = ?
         ORDER BY created_at DESC LIMIT ?`
      ).all(taskId, limit) as MemoryAuditEventRow[]
      : this.db.prepare(
        `SELECT * FROM memory_audit_events
         WHERE action = 'auto_apply'
         ORDER BY created_at DESC LIMIT ?`
      ).all(limit) as MemoryAuditEventRow[];

    return rows.map(rowToRecord);
  }
}
