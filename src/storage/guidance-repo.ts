import type Database from 'better-sqlite3';
import type { GuidanceActionType } from '../core/types.js';

interface GuidanceRow {
  id: string;
  trigger: string;
  task_id: string | null;
  action_type: string;
  payload_json: string;
  reasons_json: string;
  confidence: number;
  requires_confirmation: number;
  accepted_at: string | null;
  dismissed_at: string | null;
  executed_at: string | null;
  created_at: string;
}

export interface GuidanceEventRecord {
  id: string;
  trigger: string;
  taskId: string | null;
  actionType: GuidanceActionType;
  payload: Record<string, unknown>;
  reasons: string[];
  confidence: number;
  requiresConfirmation: boolean;
  acceptedAt: string | null;
  dismissedAt: string | null;
  executedAt: string | null;
  createdAt: string;
}

function rowToGuidanceEvent(row: GuidanceRow): GuidanceEventRecord {
  return {
    id: row.id,
    trigger: row.trigger,
    taskId: row.task_id,
    actionType: row.action_type as GuidanceActionType,
    payload: JSON.parse(row.payload_json),
    reasons: JSON.parse(row.reasons_json),
    confidence: row.confidence,
    requiresConfirmation: row.requires_confirmation === 1,
    acceptedAt: row.accepted_at,
    dismissedAt: row.dismissed_at,
    executedAt: row.executed_at,
    createdAt: row.created_at,
  };
}

export class GuidanceRepo {
  constructor(private db: Database.Database) {}

  insert(event: GuidanceEventRecord): void {
    this.db.prepare(`
      INSERT INTO guidance_events (
        id, trigger, task_id, action_type, payload_json, reasons_json,
        confidence, requires_confirmation, accepted_at, dismissed_at, executed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.trigger,
      event.taskId,
      event.actionType,
      JSON.stringify(event.payload),
      JSON.stringify(event.reasons),
      event.confidence,
      event.requiresConfirmation ? 1 : 0,
      event.acceptedAt,
      event.dismissedAt,
      event.executedAt,
      event.createdAt,
    );
  }

  findById(id: string): GuidanceEventRecord | null {
    const row = this.db.prepare('SELECT * FROM guidance_events WHERE id = ?').get(id) as GuidanceRow | undefined;
    return row ? rowToGuidanceEvent(row) : null;
  }

  findByTaskId(taskId: string): GuidanceEventRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM guidance_events WHERE task_id = ? ORDER BY created_at DESC'
    ).all(taskId) as GuidanceRow[];
    return rows.map(rowToGuidanceEvent);
  }

  markAccepted(id: string, acceptedAt: string): void {
    this.db.prepare('UPDATE guidance_events SET accepted_at = ? WHERE id = ?').run(acceptedAt, id);
  }

  markDismissed(id: string, dismissedAt: string): void {
    this.db.prepare('UPDATE guidance_events SET dismissed_at = ? WHERE id = ?').run(dismissedAt, id);
  }

  markExecuted(id: string, executedAt: string): void {
    this.db.prepare('UPDATE guidance_events SET executed_at = ? WHERE id = ?').run(executedAt, id);
  }
}
