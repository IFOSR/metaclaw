import type Database from 'better-sqlite3';

interface TaskRelationRow {
  id: string;
  source_task_id: string;
  target_task_id: string;
  relation_type: string;
  created_at: string;
}

export interface TaskRelationRecord {
  id: string;
  sourceTaskId: string;
  targetTaskId: string;
  relationType: string;
  createdAt: string;
}

function rowToTaskRelation(row: TaskRelationRow): TaskRelationRecord {
  return {
    id: row.id,
    sourceTaskId: row.source_task_id,
    targetTaskId: row.target_task_id,
    relationType: row.relation_type,
    createdAt: row.created_at,
  };
}

export class TaskRelationRepo {
  constructor(private db: Database.Database) {}

  insert(relation: TaskRelationRecord): void {
    this.db.prepare(`
      INSERT INTO task_relations (id, source_task_id, target_task_id, relation_type, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      relation.id,
      relation.sourceTaskId,
      relation.targetTaskId,
      relation.relationType,
      relation.createdAt,
    );
  }

  findBySourceTaskId(sourceTaskId: string): TaskRelationRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM task_relations WHERE source_task_id = ? ORDER BY created_at DESC'
    ).all(sourceTaskId) as TaskRelationRow[];
    return rows.map(rowToTaskRelation);
  }

  findByTargetTaskId(targetTaskId: string): TaskRelationRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM task_relations WHERE target_task_id = ? ORDER BY created_at DESC'
    ).all(targetTaskId) as TaskRelationRow[];
    return rows.map(rowToTaskRelation);
  }
}
