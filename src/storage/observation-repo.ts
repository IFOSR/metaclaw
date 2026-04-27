import type Database from 'better-sqlite3';
import type { Observation } from '../core/types.js';
import { generateObservationId } from '../utils/id.js';

interface ObsRow {
  id: string;
  pattern: string;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  source_tasks: string;
  promoted_to_preference_id: string | null;
}

function rowToObs(row: ObsRow): Observation {
  return {
    id: row.id,
    pattern: row.pattern,
    occurrenceCount: row.occurrence_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    sourceTasks: JSON.parse(row.source_tasks),
    promotedToPreferenceId: row.promoted_to_preference_id,
  };
}

export class ObservationRepo {
  constructor(private db: Database.Database) {}

  findByPattern(pattern: string): Observation | null {
    const row = this.db.prepare('SELECT * FROM observations WHERE pattern = ?').get(pattern) as ObsRow | undefined;
    return row ? rowToObs(row) : null;
  }

  upsert(pattern: string, taskId: string): Observation {
    const existing = this.findByPattern(pattern);
    const now = new Date().toISOString();

    if (existing) {
      const sourceTasks = [...existing.sourceTasks, taskId];
      this.db.prepare(`
        UPDATE observations
        SET occurrence_count = occurrence_count + 1, last_seen_at = ?, source_tasks = ?
        WHERE pattern = ?
      `).run(now, JSON.stringify(sourceTasks), pattern);

      return { ...existing, occurrenceCount: existing.occurrenceCount + 1, lastSeenAt: now, sourceTasks };
    } else {
      const id = generateObservationId();
      this.db.prepare(`
        INSERT INTO observations (id, pattern, occurrence_count, first_seen_at, last_seen_at, source_tasks)
        VALUES (?, ?, 1, ?, ?, ?)
      `).run(id, pattern, now, now, JSON.stringify([taskId]));

      return {
        id,
        pattern,
        occurrenceCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        sourceTasks: [taskId],
        promotedToPreferenceId: null,
      };
    }
  }

  upsertCandidate(pattern: string, taskId: string): Observation {
    const existing = this.findByPattern(pattern);
    const now = new Date().toISOString();

    if (existing) {
      const sourceTasks = Array.from(new Set([...existing.sourceTasks, taskId]));
      const occurrenceCount = Math.max(existing.occurrenceCount, 3);
      this.db.prepare(`
        UPDATE observations
        SET occurrence_count = ?, last_seen_at = ?, source_tasks = ?
        WHERE pattern = ?
      `).run(occurrenceCount, now, JSON.stringify(sourceTasks), pattern);

      return { ...existing, occurrenceCount, lastSeenAt: now, sourceTasks };
    }

    const id = generateObservationId();
    this.db.prepare(`
      INSERT INTO observations (id, pattern, occurrence_count, first_seen_at, last_seen_at, source_tasks)
      VALUES (?, ?, 3, ?, ?, ?)
    `).run(id, pattern, now, now, JSON.stringify([taskId]));

    return {
      id,
      pattern,
      occurrenceCount: 3,
      firstSeenAt: now,
      lastSeenAt: now,
      sourceTasks: [taskId],
      promotedToPreferenceId: null,
    };
  }

  findCandidates(): Observation[] {
    const rows = this.db.prepare(
      'SELECT * FROM observations WHERE occurrence_count >= 3 AND promoted_to_preference_id IS NULL'
    ).all() as ObsRow[];
    return rows.map(rowToObs);
  }

  markPromoted(id: string, preferenceId: string): void {
    this.db.prepare('UPDATE observations SET promoted_to_preference_id = ? WHERE id = ?').run(preferenceId, id);
  }

  findAll(): Observation[] {
    const rows = this.db.prepare('SELECT * FROM observations ORDER BY last_seen_at DESC').all() as ObsRow[];
    return rows.map(rowToObs);
  }
}
