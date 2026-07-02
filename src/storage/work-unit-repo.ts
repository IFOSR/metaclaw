import type Database from 'better-sqlite3';
import type { AgentClassKind, WorkUnit, WorkUnitEvent, WorkUnitState } from '../core/types.js';

interface WorkUnitRow {
  id: string;
  agent_class_name: string;
  agent_class_kind: AgentClassKind;
  state: WorkUnitState;
  claimed_task_id: string | null;
  claimed_subtask_id: string | null;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkUnitEventRow {
  id: string;
  work_unit_id: string;
  task_id: string | null;
  subtask_id: string | null;
  event_type: string;
  state: WorkUnitState | null;
  message: string;
  payload_json: string;
  created_at: string;
}

function rowToWorkUnit(row: WorkUnitRow): WorkUnit {
  return {
    id: row.id,
    agentClassName: row.agent_class_name,
    agentClassKind: row.agent_class_kind,
    state: row.state,
    claimedTaskId: row.claimed_task_id,
    claimedSubtaskId: row.claimed_subtask_id,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEvent(row: WorkUnitEventRow): WorkUnitEvent {
  return {
    id: row.id,
    workUnitId: row.work_unit_id,
    taskId: row.task_id,
    subtaskId: row.subtask_id,
    eventType: row.event_type,
    state: row.state,
    message: row.message,
    payload: JSON.parse(row.payload_json || '{}') as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

export class WorkUnitRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(workUnit: WorkUnit): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO work_units (
        id, agent_class_name, agent_class_kind, state, claimed_task_id, claimed_subtask_id,
        heartbeat_at, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent_class_name = excluded.agent_class_name,
        agent_class_kind = excluded.agent_class_kind,
        state = excluded.state,
        claimed_task_id = excluded.claimed_task_id,
        claimed_subtask_id = excluded.claimed_subtask_id,
        heartbeat_at = excluded.heartbeat_at,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
    `).run(
      workUnit.id,
      workUnit.agentClassName,
      workUnit.agentClassKind,
      workUnit.state,
      workUnit.claimedTaskId,
      workUnit.claimedSubtaskId,
      workUnit.heartbeatAt,
      workUnit.leaseExpiresAt,
      workUnit.createdAt || now,
      now,
    );
  }

  findById(id: string): WorkUnit | null {
    const row = this.db.prepare('SELECT * FROM work_units WHERE id = ?').get(id) as WorkUnitRow | undefined;
    return row ? rowToWorkUnit(row) : null;
  }

  findAll(): WorkUnit[] {
    const rows = this.db.prepare('SELECT * FROM work_units ORDER BY agent_class_kind ASC, id ASC').all() as WorkUnitRow[];
    return rows.map(rowToWorkUnit);
  }

  findIdleByKind(kind: AgentClassKind, candidateAgentClasses: string[] = []): WorkUnit | null {
    const rows = this.db.prepare(`
      SELECT * FROM work_units
      WHERE agent_class_kind = ? AND state = 'idle'
      ORDER BY updated_at ASC
    `).all(kind) as WorkUnitRow[];
    const candidates = candidateAgentClasses.length > 0 ? new Set(candidateAgentClasses) : null;
    const row = candidates
      ? rows.find(item => candidates.has(item.agent_class_name))
      : rows[0];
    return row ? rowToWorkUnit(row) : null;
  }

  updateState(
    id: string,
    state: WorkUnitState,
    changes: {
      claimedTaskId?: string | null;
      claimedSubtaskId?: string | null;
      heartbeatAt?: string | null;
      leaseExpiresAt?: string | null;
    } = {},
  ): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE work_units
      SET state = ?,
          claimed_task_id = ?,
          claimed_subtask_id = ?,
          heartbeat_at = ?,
          lease_expires_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      state,
      changes.claimedTaskId ?? null,
      changes.claimedSubtaskId ?? null,
      changes.heartbeatAt ?? null,
      changes.leaseExpiresAt ?? null,
      now,
      id,
    );
  }

  insertEvent(event: WorkUnitEvent): void {
    this.db.prepare(`
      INSERT INTO work_unit_events (
        id, work_unit_id, task_id, subtask_id, event_type, state, message, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.workUnitId,
      event.taskId,
      event.subtaskId,
      event.eventType,
      event.state,
      event.message,
      JSON.stringify(event.payload),
      event.createdAt,
    );
  }

  listEvents(workUnitId: string): WorkUnitEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM work_unit_events WHERE work_unit_id = ? ORDER BY created_at ASC'
    ).all(workUnitId) as WorkUnitEventRow[];
    return rows.map(rowToEvent);
  }

  markHeartbeatLost(expiredBefore: string): WorkUnit[] {
    const rows = this.db.prepare(`
      SELECT * FROM work_units
      WHERE state IN ('claimed', 'running', 'waiting') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
    `).all(expiredBefore) as WorkUnitRow[];
    for (const row of rows) {
      this.updateState(row.id, 'heartbeat_lost');
    }
    return rows.map(rowToWorkUnit);
  }
}
