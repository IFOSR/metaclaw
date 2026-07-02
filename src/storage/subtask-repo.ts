import type Database from 'better-sqlite3';
import type { AgentClassKind, AgentClassRiskLevel, Subtask, TaskStatus } from '../core/types.js';

interface SubtaskRow {
  id: string;
  task_id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  depends_on_json: string;
  required_agent_class_kind: AgentClassKind;
  agent_class_hint: string | null;
  candidate_agent_classes_json: string;
  expected_output: Subtask['expectedOutput'];
  acceptance_json: string;
  risk_level: AgentClassRiskLevel;
  result: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function parseList(value: string): string[] {
  return JSON.parse(value || '[]') as string[];
}

function rowToSubtask(row: SubtaskRow): Subtask {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    dependsOn: parseList(row.depends_on_json),
    requiredAgentClassKind: row.required_agent_class_kind,
    agentClassHint: row.agent_class_hint,
    candidateAgentClasses: parseList(row.candidate_agent_classes_json),
    expectedOutput: row.expected_output,
    acceptance: parseList(row.acceptance_json),
    riskLevel: row.risk_level,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SubtaskRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(subtask: Subtask): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO subtasks (
        id, task_id, title, goal, status, depends_on_json, required_agent_class_kind,
        agent_class_hint, candidate_agent_classes_json, expected_output, acceptance_json,
        risk_level, result, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        goal = excluded.goal,
        status = excluded.status,
        depends_on_json = excluded.depends_on_json,
        required_agent_class_kind = excluded.required_agent_class_kind,
        agent_class_hint = excluded.agent_class_hint,
        candidate_agent_classes_json = excluded.candidate_agent_classes_json,
        expected_output = excluded.expected_output,
        acceptance_json = excluded.acceptance_json,
        risk_level = excluded.risk_level,
        result = excluded.result,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run(
      subtask.id,
      subtask.taskId,
      subtask.title,
      subtask.goal,
      subtask.status,
      JSON.stringify(subtask.dependsOn),
      subtask.requiredAgentClassKind,
      subtask.agentClassHint,
      JSON.stringify(subtask.candidateAgentClasses),
      subtask.expectedOutput,
      JSON.stringify(subtask.acceptance),
      subtask.riskLevel,
      subtask.result,
      subtask.error,
      subtask.createdAt || now,
      now,
    );
  }

  listByTask(taskId: string): Subtask[] {
    const rows = this.db.prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as SubtaskRow[];
    return rows.map(rowToSubtask);
  }

  findById(id: string): Subtask | null {
    const row = this.db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id) as SubtaskRow | undefined;
    return row ? rowToSubtask(row) : null;
  }

  updateStatus(id: string, status: TaskStatus, changes: { result?: string; error?: string | null } = {}): void {
    const now = new Date().toISOString();
    const hasError = Object.prototype.hasOwnProperty.call(changes, 'error');
    this.db.prepare(`
      UPDATE subtasks
      SET status = ?,
          result = COALESCE(?, result),
          error = CASE WHEN ? THEN ? ELSE error END,
          updated_at = ?
      WHERE id = ?
    `).run(status, changes.result ?? null, hasError ? 1 : 0, changes.error ?? null, now, id);
  }

  deleteByTask(taskId: string): void {
    this.db.prepare('DELETE FROM subtasks WHERE task_id = ?').run(taskId);
  }
}
