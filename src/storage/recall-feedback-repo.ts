import type Database from 'better-sqlite3';

export type RecallFeedbackTargetKind = 'task' | 'preference';
export type RecallFeedbackAction = 'select' | 'reject' | 'irrelevant' | 'hide' | 'more';

interface RecallFeedbackRow {
  id: string;
  audit_id: string | null;
  query_task_id: string | null;
  target_kind: RecallFeedbackTargetKind;
  target_id: string;
  action: RecallFeedbackAction;
  note: string | null;
  created_at: string;
}

export interface RecallFeedbackRecord {
  id: string;
  auditId: string | null;
  queryTaskId: string | null;
  targetKind: RecallFeedbackTargetKind;
  targetId: string;
  action: RecallFeedbackAction;
  note: string | null;
  createdAt: string;
}

export interface RecallFeedbackInsert {
  id: string;
  auditId?: string | null;
  queryTaskId?: string | null;
  targetKind: RecallFeedbackTargetKind;
  targetId: string;
  action: RecallFeedbackAction;
  note?: string | null;
  createdAt: string;
}

function rowToRecallFeedback(row: RecallFeedbackRow): RecallFeedbackRecord {
  return {
    id: row.id,
    auditId: row.audit_id,
    queryTaskId: row.query_task_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    action: row.action,
    note: row.note,
    createdAt: row.created_at,
  };
}

export class RecallFeedbackRepo {
  constructor(private db: Database.Database) {}

  insert(record: RecallFeedbackInsert): void {
    this.db.prepare(`
      INSERT INTO recall_feedback (
        id, audit_id, query_task_id, target_kind, target_id, action, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.auditId ?? null,
      record.queryTaskId ?? null,
      record.targetKind,
      record.targetId,
      record.action,
      record.note ?? null,
      record.createdAt,
    );
  }

  findActiveForCandidates(input: {
    targetKind: RecallFeedbackTargetKind;
    targetIds: string[];
    queryTaskId?: string | null;
  }): RecallFeedbackRecord[] {
    if (input.targetIds.length === 0) {
      return [];
    }

    const placeholders = input.targetIds.map(() => '?').join(', ');
    const queryScope = input.queryTaskId
      ? ' AND (query_task_id IS NULL OR query_task_id = ?)'
      : '';
    const params = input.queryTaskId
      ? [input.targetKind, ...input.targetIds, input.queryTaskId]
      : [input.targetKind, ...input.targetIds];
    const rows = this.db.prepare(`
      SELECT * FROM recall_feedback
      WHERE target_kind = ? AND target_id IN (${placeholders})${queryScope}
      ORDER BY created_at DESC
    `).all(...params) as RecallFeedbackRow[];

    return rows.map(rowToRecallFeedback);
  }
}
