import type Database from 'better-sqlite3';
import type { KernelEvent } from '../kernel/control-kernel.js';

export type GenerationReplanRequestStatus =
  | 'pending_quiescence'
  | 'planning'
  | 'submitted'
  | 'waiting_for_availability'
  | 'resolved'
  | 'cancelled'
  | 'failed';

export interface GenerationReplanRequestRecord {
  id: string;
  taskId: string;
  generationId: string;
  sourceRevision: number;
  status: GenerationReplanRequestStatus;
  triggerDecisionId: string;
  quiescenceToken: string | null;
  errorSummary: string | null;
  deferredPlan: Extract<KernelEvent, { type: 'plan_proposed' }> | null;
  availabilityExplanation: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ReplanRow {
  id: string;
  task_id: string;
  generation_id: string;
  source_revision: number;
  status: GenerationReplanRequestStatus;
  trigger_decision_id: string;
  quiescence_token: string | null;
  error_summary: string | null;
  deferred_plan_json: string | null;
  availability_explanation: string | null;
  created_at: string;
  updated_at: string;
}

export class GenerationReplanRequestRepo {
  constructor(private readonly db: Database.Database) {}

  enqueue(input: {
    id: string;
    taskId: string;
    generationId: string;
    sourceRevision: number;
    triggerDecisionId: string;
    now: string;
  }): GenerationReplanRequestRecord {
    this.db.prepare(`
      INSERT OR IGNORE INTO generation_replan_requests (
        id, task_id, generation_id, source_revision, status,
        trigger_decision_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending_quiescence', ?, ?, ?)
    `).run(
      input.id,
      input.taskId,
      input.generationId,
      input.sourceRevision,
      input.triggerDecisionId,
      input.now,
      input.now,
    );
    const record = this.findByGeneration(
      input.taskId,
      input.generationId,
      input.sourceRevision,
    );
    if (!record) throw new Error(`generation replan request was not persisted: ${input.id}`);
    return record;
  }

  find(id: string): GenerationReplanRequestRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM generation_replan_requests WHERE id = ?
    `).get(id) as ReplanRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findByGeneration(
    taskId: string,
    generationId: string,
    sourceRevision: number,
  ): GenerationReplanRequestRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM generation_replan_requests
      WHERE task_id = ? AND generation_id = ? AND source_revision = ?
    `).get(taskId, generationId, sourceRevision) as ReplanRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findActive(taskId: string, generationId: string): GenerationReplanRequestRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM generation_replan_requests
      WHERE task_id = ? AND generation_id = ?
        AND status IN ('pending_quiescence', 'planning', 'submitted', 'waiting_for_availability')
      ORDER BY source_revision DESC
      LIMIT 1
    `).get(taskId, generationId) as ReplanRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  markPlanning(id: string, quiescenceToken: string, now: string): boolean {
    const changed = this.db.prepare(`
      UPDATE generation_replan_requests
      SET status = 'planning', quiescence_token = ?,
          planning_started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending_quiescence'
    `).run(quiescenceToken, now, now, id).changes;
    if (changed === 1) return true;
    const current = this.find(id);
    return current?.status === 'planning'
      && current.quiescenceToken === quiescenceToken;
  }

  markSubmitted(id: string, quiescenceToken: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE generation_replan_requests
      SET status = 'submitted', submitted_at = ?, updated_at = ?
      WHERE id = ? AND status = 'planning' AND quiescence_token = ?
    `).run(now, now, id, quiescenceToken).changes === 1;
  }

  deferForAvailability(
    id: string,
    event: Extract<KernelEvent, { type: 'plan_proposed' }>,
    explanation: string,
    now: string,
  ): boolean {
    return this.db.prepare(`
      UPDATE generation_replan_requests
      SET status = 'waiting_for_availability',
          deferred_plan_json = ?,
          availability_explanation = ?,
          updated_at = ?
      WHERE id = ? AND status IN ('planning', 'submitted')
    `).run(JSON.stringify(event), explanation, now, id).changes === 1;
  }

  listWaitingForAvailability(): GenerationReplanRequestRecord[] {
    return (this.db.prepare(`
      SELECT * FROM generation_replan_requests
      WHERE status = 'waiting_for_availability'
      ORDER BY created_at
    `).all() as ReplanRow[]).map(rowToRecord);
  }

  submitPlan(
    id: string,
    quiescenceToken: string,
    now: string,
  ): boolean {
    const current = this.find(id);
    if (current?.status === 'submitted' && current.quiescenceToken === quiescenceToken) {
      return true;
    }
    return this.db.prepare(`
      UPDATE generation_replan_requests
      SET status = 'submitted', submitted_at = ?, updated_at = ?
      WHERE id = ? AND status = 'planning' AND quiescence_token = ?
    `).run(now, now, id, quiescenceToken).changes === 1;
  }

  resolve(id: string, now: string): void {
    this.db.prepare(`
      UPDATE generation_replan_requests
      SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('planning', 'submitted', 'waiting_for_availability')
    `).run(now, now, id);
  }

  cancelTask(taskId: string, decisionId: string, now: string): number {
    return this.db.prepare(`
      UPDATE generation_replan_requests
      SET status = 'cancelled', cancelled_at = ?, updated_at = ?,
          error_summary = ?
      WHERE task_id = ?
        AND status IN ('pending_quiescence', 'planning', 'submitted', 'waiting_for_availability')
    `).run(now, now, `cancelled by ${decisionId}`, taskId).changes;
  }

  fail(id: string, errorSummary: string, now: string): void {
    this.db.prepare(`
      UPDATE generation_replan_requests
      SET status = 'failed', error_summary = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending_quiescence', 'planning')
    `).run(errorSummary, now, id);
  }
}

function rowToRecord(row: ReplanRow): GenerationReplanRequestRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    generationId: row.generation_id,
    sourceRevision: row.source_revision,
    status: row.status,
    triggerDecisionId: row.trigger_decision_id,
    quiescenceToken: row.quiescence_token,
    errorSummary: row.error_summary,
    deferredPlan: row.deferred_plan_json
      ? JSON.parse(row.deferred_plan_json) as Extract<KernelEvent, { type: 'plan_proposed' }>
      : null,
    availabilityExplanation: row.availability_explanation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
