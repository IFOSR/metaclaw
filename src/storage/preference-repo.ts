import type Database from 'better-sqlite3';
import type { Preference, PreferenceScope, PreferenceStatus } from '../core/types.js';
import { generateUsageId } from '../utils/id.js';

interface PrefRow {
  id: string;
  type: string;
  scope: string;
  subject: string | null;
  content: string;
  status: string;
  confidence: number;
  occurrence_count: number;
  source_tasks: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  confirmed_at: string | null;
}

function rowToPref(row: PrefRow): Preference {
  return {
    id: row.id,
    type: row.type,
    scope: row.scope as PreferenceScope,
    subject: row.subject,
    content: row.content,
    status: row.status as PreferenceStatus,
    confidence: row.confidence,
    occurrenceCount: row.occurrence_count,
    sourceTasks: JSON.parse(row.source_tasks),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    confirmedAt: row.confirmed_at,
  };
}

export class PreferenceRepo {
  constructor(private db: Database.Database) {}

  insert(pref: Preference): void {
    this.db.prepare(`
      INSERT INTO preferences (id, type, scope, subject, content, status, confidence,
        occurrence_count, source_tasks, created_at, updated_at, last_used_at, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pref.id, pref.type, pref.scope, pref.subject, pref.content, pref.status,
      pref.confidence, pref.occurrenceCount, JSON.stringify(pref.sourceTasks),
      pref.createdAt, pref.updatedAt, pref.lastUsedAt, pref.confirmedAt,
    );
  }

  findById(id: string): Preference | null {
    const row = this.db.prepare('SELECT * FROM preferences WHERE id = ?').get(id) as PrefRow | undefined;
    return row ? rowToPref(row) : null;
  }

  findBySubject(subject: string): Preference[] {
    const rows = this.db.prepare(
      `SELECT * FROM preferences WHERE subject = ? AND status = 'confirmed'`
    ).all(subject) as PrefRow[];
    return rows.map(rowToPref);
  }

  searchByKeyword(keyword: string): Preference[] {
    const rows = this.db.prepare(
      `SELECT * FROM preferences WHERE content LIKE ? AND status = 'confirmed'`
    ).all(`%${keyword}%`) as PrefRow[];
    return rows.map(rowToPref);
  }

  findByStatus(status: PreferenceStatus): Preference[] {
    const rows = this.db.prepare('SELECT * FROM preferences WHERE status = ?').all(status) as PrefRow[];
    return rows.map(rowToPref);
  }

  findByScope(scope: PreferenceScope): Preference[] {
    const rows = this.db.prepare('SELECT * FROM preferences WHERE scope = ?').all(scope) as PrefRow[];
    return rows.map(rowToPref);
  }

  findAll(): Preference[] {
    const rows = this.db.prepare('SELECT * FROM preferences ORDER BY updated_at DESC').all() as PrefRow[];
    return rows.map(rowToPref);
  }

  update(id: string, changes: Partial<Preference>): void {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (changes.type !== undefined) { sets.push('type = ?'); values.push(changes.type); }
    if (changes.scope !== undefined) { sets.push('scope = ?'); values.push(changes.scope); }
    if (changes.subject !== undefined) { sets.push('subject = ?'); values.push(changes.subject); }
    if (changes.content !== undefined) { sets.push('content = ?'); values.push(changes.content); }
    if (changes.status !== undefined) { sets.push('status = ?'); values.push(changes.status); }
    if (changes.confidence !== undefined) { sets.push('confidence = ?'); values.push(changes.confidence); }
    if (changes.occurrenceCount !== undefined) { sets.push('occurrence_count = ?'); values.push(changes.occurrenceCount); }
    if (changes.sourceTasks !== undefined) { sets.push('source_tasks = ?'); values.push(JSON.stringify(changes.sourceTasks)); }
    if (changes.lastUsedAt !== undefined) { sets.push('last_used_at = ?'); values.push(changes.lastUsedAt); }
    if (changes.confirmedAt !== undefined) { sets.push('confirmed_at = ?'); values.push(changes.confirmedAt); }

    values.push(id);
    this.db.prepare(`UPDATE preferences SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM preferences WHERE id = ?').run(id);
  }

  recordUsage(prefId: string, taskId: string): void {
    this.db.prepare(`
      INSERT INTO preference_usage (id, preference_id, task_id, injected_at)
      VALUES (?, ?, ?, ?)
    `).run(generateUsageId(), prefId, taskId, new Date().toISOString());

    this.update(prefId, { lastUsedAt: new Date().toISOString() });
  }
}
