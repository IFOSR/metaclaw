import type Database from 'better-sqlite3';
import { redactSkillUsageEventText } from '../executor/skill-usage-event-parser.js';

export type ExecutorSkillInstallAction = 'install' | 'update' | 'disable' | 'deprecate';
export type ExecutorSkillInstallStatus = 'success' | 'failed' | 'unsupported' | 'blocked';

interface ExecutorSkillInstallEventRow {
  id: string;
  candidate_id: string;
  package_id: string | null;
  executor_name: string;
  action: ExecutorSkillInstallAction;
  status: ExecutorSkillInstallStatus;
  message: string;
  created_at: string;
}

export interface ExecutorSkillInstallEventRecord {
  id: string;
  candidateId: string;
  packageId: string | null;
  executorName: string;
  action: ExecutorSkillInstallAction;
  status: ExecutorSkillInstallStatus;
  message: string;
  createdAt: string;
}

export interface CreateExecutorSkillInstallEventInput extends ExecutorSkillInstallEventRecord {}

function rowToRecord(row: ExecutorSkillInstallEventRow): ExecutorSkillInstallEventRecord {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    packageId: row.package_id,
    executorName: row.executor_name,
    action: row.action,
    status: row.status,
    message: row.message,
    createdAt: row.created_at,
  };
}

export class ExecutorSkillInstallEventRepo {
  constructor(private db: Database.Database) {}

  create(input: CreateExecutorSkillInstallEventInput): void {
    this.db.prepare(`
      INSERT INTO executor_skill_install_events (
        id, candidate_id, package_id, executor_name, action, status, message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.candidateId,
      input.packageId,
      input.executorName,
      input.action,
      input.status,
      redactSkillUsageEventText(input.message),
      input.createdAt,
    );
  }

  listByCandidate(candidateId: string): ExecutorSkillInstallEventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM executor_skill_install_events
      WHERE candidate_id = ?
      ORDER BY rowid ASC
    `).all(candidateId) as ExecutorSkillInstallEventRow[];
    return rows.map(rowToRecord);
  }
}
