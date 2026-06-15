import type Database from 'better-sqlite3';
import type { TaskMemoryKind } from '../core/types.js';

interface TaskMemoryEmbeddingRow {
  id: string;
  task_id: string;
  memory_kind: string;
  source_id: string;
  provider: string;
  model: string;
  dimension: number;
  vector_json: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

export interface TaskMemoryEmbeddingRecord {
  id: string;
  taskId: string;
  memoryKind: TaskMemoryKind;
  sourceId: string;
  provider: string;
  model: string;
  dimension: number;
  vector: number[];
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

function rowToTaskMemoryEmbedding(row: TaskMemoryEmbeddingRow): TaskMemoryEmbeddingRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    memoryKind: row.memory_kind as TaskMemoryKind,
    sourceId: row.source_id,
    provider: row.provider,
    model: row.model,
    dimension: row.dimension,
    vector: JSON.parse(row.vector_json),
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskMemoryEmbeddingRepo {
  constructor(private db: Database.Database) {}

  upsert(record: TaskMemoryEmbeddingRecord): void {
    const existing = this.findBySource(record.taskId, record.memoryKind, record.sourceId);
    if (existing) {
      this.db.prepare(`
        UPDATE task_memory_embeddings
        SET provider = ?, model = ?, dimension = ?, vector_json = ?, content_hash = ?, updated_at = ?
        WHERE task_id = ? AND memory_kind = ? AND source_id = ?
      `).run(
        record.provider,
        record.model,
        record.dimension,
        JSON.stringify(record.vector),
        record.contentHash,
        record.updatedAt,
        record.taskId,
        record.memoryKind,
        record.sourceId,
      );
      return;
    }

    this.db.prepare(`
      INSERT INTO task_memory_embeddings (
        id, task_id, memory_kind, source_id, provider, model, dimension,
        vector_json, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.taskId,
      record.memoryKind,
      record.sourceId,
      record.provider,
      record.model,
      record.dimension,
      JSON.stringify(record.vector),
      record.contentHash,
      record.createdAt,
      record.updatedAt,
    );
  }

  findBySource(
    taskId: string,
    memoryKind: TaskMemoryKind,
    sourceId: string,
  ): TaskMemoryEmbeddingRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM task_memory_embeddings WHERE task_id = ? AND memory_kind = ? AND source_id = ? LIMIT 1'
    ).get(taskId, memoryKind, sourceId) as TaskMemoryEmbeddingRow | undefined;
    return row ? rowToTaskMemoryEmbedding(row) : null;
  }

  findByTaskId(taskId: string): TaskMemoryEmbeddingRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM task_memory_embeddings WHERE task_id = ? ORDER BY updated_at DESC'
    ).all(taskId) as TaskMemoryEmbeddingRow[];
    return rows.map(rowToTaskMemoryEmbedding);
  }

  findByTaskIds(taskIds: string[]): TaskMemoryEmbeddingRecord[] {
    const uniqueTaskIds = Array.from(new Set(taskIds));
    if (uniqueTaskIds.length === 0) {
      return [];
    }

    const placeholders = uniqueTaskIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT * FROM task_memory_embeddings WHERE task_id IN (${placeholders}) ORDER BY updated_at DESC`
    ).all(...uniqueTaskIds) as TaskMemoryEmbeddingRow[];
    return rows.map(rowToTaskMemoryEmbedding);
  }

  findAll(): TaskMemoryEmbeddingRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM task_memory_embeddings ORDER BY updated_at DESC'
    ).all() as TaskMemoryEmbeddingRow[];
    return rows.map(rowToTaskMemoryEmbedding);
  }
}
