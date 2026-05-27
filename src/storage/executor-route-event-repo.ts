import type Database from 'better-sqlite3';
import type {
  ExecutorRouteAction,
  ExecutorRouteCandidate,
  ExecutorRouteRejectedCandidate,
  TaskRouteIntent,
} from '../core/executor-router.js';

interface ExecutorRouteEventRow {
  id: string;
  task_id: string | null;
  user_input: string;
  selected_executor: string;
  action: ExecutorRouteAction;
  candidates_json: string;
  primary_intent?: TaskRouteIntent;
  matched_boundary_json?: string;
  rejected_json?: string;
  reason: string;
  confirmed_by_user: number;
  result: string | null;
  created_at: string;
}

export interface ExecutorRouteEventRecord {
  id: string;
  taskId: string | null;
  userInput: string;
  selectedExecutor: string;
  action: ExecutorRouteAction;
  candidates: ExecutorRouteCandidate[];
  primaryIntent: TaskRouteIntent;
  matchedBoundary: string[];
  rejected: ExecutorRouteRejectedCandidate[];
  reason: string;
  confirmedByUser: boolean;
  result: string | null;
  createdAt: string;
}

function rowToRecord(row: ExecutorRouteEventRow): ExecutorRouteEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    userInput: row.user_input,
    selectedExecutor: row.selected_executor,
    action: row.action,
    candidates: JSON.parse(row.candidates_json || '[]') as ExecutorRouteCandidate[],
    primaryIntent: row.primary_intent ?? 'general',
    matchedBoundary: JSON.parse(row.matched_boundary_json || '[]') as string[],
    rejected: JSON.parse(row.rejected_json || '[]') as ExecutorRouteRejectedCandidate[],
    reason: row.reason,
    confirmedByUser: row.confirmed_by_user === 1,
    result: row.result,
    createdAt: row.created_at,
  };
}

export class ExecutorRouteEventRepo {
  constructor(private db: Database.Database) {}

  insert(record: ExecutorRouteEventRecord): void {
    this.db.prepare(`
      INSERT INTO executor_route_events (
        id, task_id, user_input, selected_executor, action, candidates_json,
        primary_intent, matched_boundary_json, rejected_json, reason, confirmed_by_user,
        result, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.taskId,
      record.userInput,
      record.selectedExecutor,
      record.action,
      JSON.stringify(record.candidates),
      record.primaryIntent,
      JSON.stringify(record.matchedBoundary),
      JSON.stringify(record.rejected),
      record.reason,
      record.confirmedByUser ? 1 : 0,
      record.result,
      record.createdAt,
    );
  }

  updateResult(id: string, result: string): void {
    this.db.prepare('UPDATE executor_route_events SET result = ? WHERE id = ?').run(result, id);
  }

  listRecent(limit = 20): ExecutorRouteEventRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM executor_route_events ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as ExecutorRouteEventRow[];
    return rows.map(rowToRecord);
  }
}
