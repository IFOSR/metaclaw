import type Database from 'better-sqlite3';
import type { TaskEvent } from '../core/types.js';

interface TaskEventRow {
  id: string;
  task_id: string;
  subtask_id: string | null;
  event_type: string;
  message: string;
  payload_json: string;
  created_at: string;
}

function rowToEvent(row: TaskEventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    subtaskId: row.subtask_id,
    eventType: row.event_type,
    message: row.message,
    payload: JSON.parse(row.payload_json || '{}') as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

export class TaskEventRepo {
  constructor(private readonly db: Database.Database) {}

  insert(event: TaskEvent): void {
    this.db.prepare(`
      INSERT INTO task_events (
        id, task_id, subtask_id, event_type, message, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.taskId,
      event.subtaskId,
      event.eventType,
      event.message,
      JSON.stringify(event.payload),
      event.createdAt,
    );
  }

  listByTask(taskId: string): TaskEvent[] {
    const rows = this.db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as TaskEventRow[];
    return rows.map(rowToEvent);
  }

  listRecent(limit = 20): TaskEvent[] {
    const rows = this.db.prepare('SELECT * FROM task_events ORDER BY created_at DESC LIMIT ?').all(limit) as TaskEventRow[];
    return rows.map(rowToEvent);
  }
}
