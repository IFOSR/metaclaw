import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { ExecutorSkillInstallEventRepo } from '../../src/storage/executor-skill-install-event-repo.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('Phase E3 executor skill install audit storage', () => {
  it('migrates executor_skill_install_events and persists install/update audit events', () => {
    const db = createTestDb();
    const columns = db.prepare('PRAGMA table_info(executor_skill_install_events)').all() as Array<{ name: string }>;
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining([
      'id',
      'candidate_id',
      'package_id',
      'executor_name',
      'action',
      'status',
      'message',
      'created_at',
    ]));

    const repo = new ExecutorSkillInstallEventRepo(db);
    repo.create({
      id: 'install_1',
      candidateId: 'lc_skill_1',
      packageId: 'pkg_1',
      executorName: 'mock-executor',
      action: 'install',
      status: 'success',
      message: 'installed skill safely',
      createdAt: '2026-04-27T10:00:00.000Z',
    });
    repo.create({
      id: 'install_2',
      candidateId: 'lc_skill_1',
      packageId: 'pkg_1',
      executorName: 'mock-executor',
      action: 'update',
      status: 'failed',
      message: 'token=super-secret-value',
      createdAt: '2026-04-27T10:01:00.000Z',
    });

    const events = repo.listByCandidate('lc_skill_1');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: 'install_1',
      candidateId: 'lc_skill_1',
      action: 'install',
      status: 'success',
    });
    expect(events[1].message).toContain('[REDACTED]');
    expect(events[1].message).not.toContain('super-secret-value');
  });
});
