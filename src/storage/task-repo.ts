import type Database from 'better-sqlite3';
import type { Task, TaskSnapshot, TaskStatus, PrioritySignals, Dependency } from '../core/types.js';

interface TaskRow {
  id: string;
  title: string;
  goal: string;
  status: string;
  summary: string;
  snapshot_json: string;
  resources_json: string;
  dependencies_json: string;
  priority_json: string | null;
  injected_prefs_json: string;
  last_scheduling_reason: string | null;
  last_interruption_reason: string | null;
  interruption_count: number | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    status: row.status as TaskStatus,
    summary: row.summary,
    snapshots: JSON.parse(row.snapshot_json),
    resources: JSON.parse(row.resources_json),
    dependencies: JSON.parse(row.dependencies_json),
    prioritySignals: row.priority_json
      ? JSON.parse(row.priority_json)
      : { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
    injectedPreferences: JSON.parse(row.injected_prefs_json),
    lastSchedulingReason: row.last_scheduling_reason ?? '',
    lastInterruptionReason: row.last_interruption_reason ?? '',
    interruptionCount: row.interruption_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskRepo {
  constructor(private db: Database.Database) {}

  insert(task: Task): void {
    this.db.prepare(`
      INSERT INTO tasks (id, title, goal, status, summary, snapshot_json, resources_json,
        dependencies_json, priority_json, injected_prefs_json, last_scheduling_reason,
        last_interruption_reason, interruption_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.title, task.goal, task.status, task.summary,
      JSON.stringify(task.snapshots), JSON.stringify(task.resources),
      JSON.stringify(task.dependencies), JSON.stringify(task.prioritySignals),
      JSON.stringify(task.injectedPreferences), task.lastSchedulingReason,
      task.lastInterruptionReason, task.interruptionCount, task.createdAt, task.updatedAt,
    );
  }

  findById(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  findByStatus(status: TaskStatus): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC').all(status) as TaskRow[];
    return rows.map(rowToTask);
  }

  findActive(): Task[] {
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE status IN ('created', 'ready', 'running', 'parked', 'blocked') ORDER BY updated_at DESC`
    ).all() as TaskRow[];
    return rows.map(rowToTask);
  }

  findAll(): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all() as TaskRow[];
    return rows.map(rowToTask);
  }

  update(id: string, changes: Partial<Task>): void {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (changes.title !== undefined) { sets.push('title = ?'); values.push(changes.title); }
    if (changes.goal !== undefined) { sets.push('goal = ?'); values.push(changes.goal); }
    if (changes.status !== undefined) { sets.push('status = ?'); values.push(changes.status); }
    if (changes.summary !== undefined) { sets.push('summary = ?'); values.push(changes.summary); }
    if (changes.snapshots !== undefined) { sets.push('snapshot_json = ?'); values.push(JSON.stringify(changes.snapshots)); }
    if (changes.resources !== undefined) { sets.push('resources_json = ?'); values.push(JSON.stringify(changes.resources)); }
    if (changes.dependencies !== undefined) { sets.push('dependencies_json = ?'); values.push(JSON.stringify(changes.dependencies)); }
    if (changes.prioritySignals !== undefined) { sets.push('priority_json = ?'); values.push(JSON.stringify(changes.prioritySignals)); }
    if (changes.injectedPreferences !== undefined) { sets.push('injected_prefs_json = ?'); values.push(JSON.stringify(changes.injectedPreferences)); }
    if (changes.lastSchedulingReason !== undefined) { sets.push('last_scheduling_reason = ?'); values.push(changes.lastSchedulingReason); }
    if (changes.lastInterruptionReason !== undefined) { sets.push('last_interruption_reason = ?'); values.push(changes.lastInterruptionReason); }
    if (changes.interruptionCount !== undefined) { sets.push('interruption_count = ?'); values.push(changes.interruptionCount); }

    values.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  updateStatus(id: string, status: TaskStatus): void {
    this.update(id, { status });
  }

  appendSnapshot(id: string, snapshot: TaskSnapshot): void {
    const task = this.findById(id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    const snapshots = [...task.snapshots, snapshot];
    this.update(id, { snapshots });
  }
}
