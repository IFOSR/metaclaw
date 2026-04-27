import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { SkillUsageEventRepo } from '../../src/storage/skill-usage-event-repo.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('Phase E2 skill usage event storage', () => {
  it('creates executor_skill_usage_events and persists events by task/execution', () => {
    const db = createTestDb();
    const repo = new SkillUsageEventRepo(db);

    repo.insert({
      id: 'sue_1',
      taskId: 'task_1',
      executionId: 'exec_1',
      executorName: 'codex-cli',
      skillName: 'test-driven-development',
      skillVersion: '1.1.0',
      eventType: 'skill_started',
      message: '开始按 TDD 执行',
      payload: { phase: 'RED' },
      createdAt: '2026-04-27T01:00:00Z',
    });

    const byTask = repo.listByTask('task_1');
    expect(byTask).toHaveLength(1);
    expect(byTask[0]).toMatchObject({
      id: 'sue_1',
      taskId: 'task_1',
      executionId: 'exec_1',
      executorName: 'codex-cli',
      skillName: 'test-driven-development',
      skillVersion: '1.1.0',
      eventType: 'skill_started',
      message: '开始按 TDD 执行',
      payload: { phase: 'RED' },
    });

    expect(repo.listByExecution('exec_1')).toHaveLength(1);
    expect(repo.listByExecution('missing')).toHaveLength(0);
  });

  it('redacts secret-like payloads before persistence', () => {
    const db = createTestDb();
    const repo = new SkillUsageEventRepo(db);

    repo.insert({
      id: 'sue_2',
      taskId: 'task_1',
      executionId: 'exec_1',
      executorName: 'codex-cli',
      skillName: 'debugging',
      skillVersion: null,
      eventType: 'skill_progress',
      message: 'token=sk-abc123 已读取配置',
      payload: { apiKey: 'sk-secret-value', nested: { password: 'plain-text' } },
      createdAt: '2026-04-27T01:01:00Z',
    });

    const [event] = repo.listByTask('task_1');
    expect(event.message).toContain('[REDACTED]');
    expect(JSON.stringify(event.payload)).not.toContain('sk-secret-value');
    expect(JSON.stringify(event.payload)).not.toContain('plain-text');
  });
});
