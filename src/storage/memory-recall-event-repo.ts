import type Database from 'better-sqlite3';

interface MemoryRecallEventRow {
  id: string;
  task_id: string | null;
  query_text: string;
  query_hash: string;
  task_candidates_json: string;
  preference_candidates_json: string;
  review_summary_json: string;
  accepted_candidates_json: string;
  created_at: string;
}

export interface MemoryRecallEventRecord {
  id: string;
  taskId: string | null;
  queryText: string;
  queryHash: string;
  taskCandidates: unknown[];
  preferenceCandidates: unknown[];
  reviewSummary: Record<string, unknown>;
  acceptedCandidates: unknown[];
  createdAt: string;
}

function rowToMemoryRecallEvent(row: MemoryRecallEventRow): MemoryRecallEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    queryText: row.query_text,
    queryHash: row.query_hash,
    taskCandidates: JSON.parse(row.task_candidates_json),
    preferenceCandidates: JSON.parse(row.preference_candidates_json),
    reviewSummary: JSON.parse(row.review_summary_json),
    acceptedCandidates: JSON.parse(row.accepted_candidates_json),
    createdAt: row.created_at,
  };
}

export class MemoryRecallEventRepo {
  constructor(private db: Database.Database) {}

  insert(record: MemoryRecallEventRecord): void {
    this.db.prepare(`
      INSERT INTO memory_recall_events (
        id, task_id, query_text, query_hash, task_candidates_json,
        preference_candidates_json, review_summary_json, accepted_candidates_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.taskId,
      record.queryText,
      record.queryHash,
      JSON.stringify(record.taskCandidates),
      JSON.stringify(record.preferenceCandidates),
      JSON.stringify(record.reviewSummary),
      JSON.stringify(record.acceptedCandidates),
      record.createdAt,
    );
  }

  findById(id: string): MemoryRecallEventRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM memory_recall_events WHERE id = ? LIMIT 1'
    ).get(id) as MemoryRecallEventRow | undefined;
    return row ? rowToMemoryRecallEvent(row) : null;
  }
}
