import type Database from 'better-sqlite3';

interface PreferenceEmbeddingRow {
  id: string;
  preference_id: string;
  provider: string;
  model: string;
  dimension: number;
  vector_json: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

export interface PreferenceEmbeddingRecord {
  id: string;
  preferenceId: string;
  provider: string;
  model: string;
  dimension: number;
  vector: number[];
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

function rowToPreferenceEmbedding(row: PreferenceEmbeddingRow): PreferenceEmbeddingRecord {
  return {
    id: row.id,
    preferenceId: row.preference_id,
    provider: row.provider,
    model: row.model,
    dimension: row.dimension,
    vector: JSON.parse(row.vector_json),
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PreferenceEmbeddingRepo {
  constructor(private db: Database.Database) {}

  upsert(record: PreferenceEmbeddingRecord): void {
    const existing = this.findByPreferenceId(record.preferenceId);
    if (existing) {
      this.db.prepare(`
        UPDATE preference_embeddings
        SET provider = ?, model = ?, dimension = ?, vector_json = ?, content_hash = ?, updated_at = ?
        WHERE preference_id = ?
      `).run(
        record.provider,
        record.model,
        record.dimension,
        JSON.stringify(record.vector),
        record.contentHash,
        record.updatedAt,
        record.preferenceId,
      );
      return;
    }

    this.db.prepare(`
      INSERT INTO preference_embeddings (
        id, preference_id, provider, model, dimension, vector_json, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.preferenceId,
      record.provider,
      record.model,
      record.dimension,
      JSON.stringify(record.vector),
      record.contentHash,
      record.createdAt,
      record.updatedAt,
    );
  }

  findByPreferenceId(preferenceId: string): PreferenceEmbeddingRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM preference_embeddings WHERE preference_id = ? LIMIT 1'
    ).get(preferenceId) as PreferenceEmbeddingRow | undefined;
    return row ? rowToPreferenceEmbedding(row) : null;
  }

  findAll(): PreferenceEmbeddingRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM preference_embeddings ORDER BY updated_at DESC'
    ).all() as PreferenceEmbeddingRow[];
    return rows.map(rowToPreferenceEmbedding);
  }
}
