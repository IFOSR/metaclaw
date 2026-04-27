import type Database from 'better-sqlite3';

export type ReflectionEventSourceType = 'task_completion' | 'user_feedback' | 'executor_skill_usage' | 'recall_feedback';

interface ReflectionEventRow {
  id: string;
  source_type: ReflectionEventSourceType;
  source_id: string | null;
  task_id: string | null;
  summary: string;
  evidence_json: string;
  created_at: string;
}

export interface ReflectionEventRecord {
  id: string;
  sourceType: ReflectionEventSourceType;
  sourceId: string | null;
  taskId: string | null;
  summary: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface ReflectionEventInsert {
  id: string;
  sourceType: ReflectionEventSourceType;
  sourceId?: string | null;
  taskId?: string | null;
  summary: string;
  evidence?: Record<string, unknown>;
  createdAt: string;
}

function rowToReflectionEvent(row: ReflectionEventRow): ReflectionEventRecord {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    taskId: row.task_id,
    summary: row.summary,
    evidence: JSON.parse(row.evidence_json || '{}'),
    createdAt: row.created_at,
  };
}

export class ReflectionEventRepo {
  constructor(private db: Database.Database) {}

  insert(record: ReflectionEventInsert): void {
    this.db.prepare(`
      INSERT INTO reflection_events (
        id, source_type, source_id, task_id, summary, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.sourceType,
      record.sourceId ?? null,
      record.taskId ?? null,
      record.summary,
      JSON.stringify(record.evidence ?? {}),
      record.createdAt,
    );
  }

  findById(id: string): ReflectionEventRecord | null {
    const row = this.db.prepare('SELECT * FROM reflection_events WHERE id = ?').get(id) as ReflectionEventRow | undefined;
    return row ? rowToReflectionEvent(row) : null;
  }
}
