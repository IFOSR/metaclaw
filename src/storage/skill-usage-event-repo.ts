import type Database from 'better-sqlite3';
import { redactSkillUsageEventPayload, redactSkillUsageEventText } from '../executor/skill-usage-event-parser.js';

export type SkillUsageEventType =
  | 'skill_started'
  | 'skill_step_started'
  | 'skill_step_completed'
  | 'skill_progress'
  | 'skill_completed'
  | 'skill_failed'
  | 'skill_skipped'
  | 'skill_suggested_patch';

interface SkillUsageEventRow {
  id: string;
  task_id: string;
  execution_id: string;
  executor_name: string;
  skill_name: string;
  skill_version: string | null;
  event_type: SkillUsageEventType;
  message: string;
  payload_json: string;
  created_at: string;
}

export interface SkillUsageEventRecord {
  id: string;
  taskId: string;
  executionId: string;
  executorName: string;
  skillName: string;
  skillVersion: string | null;
  eventType: SkillUsageEventType;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SkillUsageEventInsert extends SkillUsageEventRecord {}

function rowToSkillUsageEvent(row: SkillUsageEventRow): SkillUsageEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    executionId: row.execution_id,
    executorName: row.executor_name,
    skillName: row.skill_name,
    skillVersion: row.skill_version,
    eventType: row.event_type,
    message: row.message,
    payload: JSON.parse(row.payload_json || '{}') as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

export class SkillUsageEventRepo {
  constructor(private readonly db: Database.Database) {}

  insert(record: SkillUsageEventInsert): void {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO executor_skill_usage_events (
          id, task_id, execution_id, executor_name, skill_name, skill_version,
          event_type, message, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.taskId,
        record.executionId,
        record.executorName,
        record.skillName,
        record.skillVersion,
        record.eventType,
        redactSkillUsageEventText(record.message),
        JSON.stringify(redactSkillUsageEventPayload(record.payload)),
        record.createdAt,
      );
      this.recordEffectSummary(record);
    })();
  }

  private recordEffectSummary(record: SkillUsageEventInsert): void {
    if (!['skill_completed', 'skill_failed', 'skill_skipped', 'skill_suggested_patch'].includes(record.eventType)) {
      return;
    }

    const used = record.eventType === 'skill_completed' || record.eventType === 'skill_failed' || record.eventType === 'skill_skipped' || record.eventType === 'skill_suggested_patch' ? 1 : 0;
    const success = record.eventType === 'skill_completed' ? 1 : 0;
    const failure = record.eventType === 'skill_failed' ? 1 : 0;
    const helpful = record.payload?.helpful === true || record.eventType === 'skill_completed' ? 1 : 0;
    const patch = record.eventType === 'skill_suggested_patch' ? 1 : 0;
    const failureReason = record.eventType === 'skill_failed' ? record.message : null;
    const id = `ses_${Buffer.from(`${record.executorName}:${record.skillName}:${record.skillVersion ?? 'unversioned'}`).toString('base64url').slice(0, 40)}`;

    this.db.prepare(`
      INSERT INTO skill_effect_summaries (
        id, executor_name, skill_name, skill_version, used_count, success_count,
        failure_count, helpful_count, patch_candidate_count, last_used_at,
        last_failure_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(executor_name, skill_name, skill_version_key) DO UPDATE SET
        used_count = used_count + excluded.used_count,
        success_count = success_count + excluded.success_count,
        failure_count = failure_count + excluded.failure_count,
        helpful_count = helpful_count + excluded.helpful_count,
        patch_candidate_count = patch_candidate_count + excluded.patch_candidate_count,
        last_used_at = excluded.last_used_at,
        last_failure_reason = COALESCE(excluded.last_failure_reason, skill_effect_summaries.last_failure_reason),
        updated_at = excluded.updated_at
    `).run(
      id,
      record.executorName,
      record.skillName,
      record.skillVersion,
      used,
      success,
      failure,
      helpful,
      patch,
      record.createdAt,
      failureReason,
      record.createdAt,
      record.createdAt,
    );
  }

  listByTask(taskId: string): SkillUsageEventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM executor_skill_usage_events
      WHERE task_id = ?
      ORDER BY rowid ASC
    `).all(taskId) as SkillUsageEventRow[];
    return rows.map(rowToSkillUsageEvent);
  }

  listByExecution(executionId: string): SkillUsageEventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM executor_skill_usage_events
      WHERE execution_id = ?
      ORDER BY rowid ASC
    `).all(executionId) as SkillUsageEventRow[];
    return rows.map(rowToSkillUsageEvent);
  }
}
