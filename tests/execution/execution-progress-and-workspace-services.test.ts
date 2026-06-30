import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { ExecutionProgressService } from '../../src/execution/execution-progress-service.js';
import { SkillUsageEventRepo } from '../../src/storage/skill-usage-event-repo.js';
import { WorkspaceTargetService } from '../../src/execution/workspace-target-service.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('execution progress and workspace services', () => {
  it('records skill usage events, returns verifier evidence, and dedupes user-visible progress', () => {
    const db = createDb();
    const appendOutput = vi.fn();
    const service = new ExecutionProgressService(db);
    const tracker = service.createTracker({
      taskId: 'task_1',
      executionId: 'exec_1',
      appendOutput,
    });
    const executor = { name: 'codex-cli' } as ExecutorAdapter;

    tracker.onProgress({
      kind: 'skill',
      text: 'RED 测试已创建',
      skillEvent: {
        eventType: 'skill_progress',
        skillName: 'test-driven-development',
        skillVersion: '1.0.0',
        message: 'RED 测试已创建',
        payload: { phase: 'red' },
      },
    }, executor);
    tracker.onProgress({
      kind: 'skill',
      text: 'RED 测试已创建',
      skillEvent: {
        eventType: 'skill_progress',
        skillName: 'test-driven-development',
        skillVersion: '1.0.0',
        message: 'RED 测试已创建',
        payload: { phase: 'red' },
      },
    }, executor);

    expect(new SkillUsageEventRepo(db).listByExecution('exec_1')).toHaveLength(2);
    expect(appendOutput).toHaveBeenCalledTimes(1);
    expect(tracker.evidenceText).toHaveLength(2);
    expect(tracker.evidenceText[0]).toContain('skill_event=skill_progress');
  });

  it('creates workspace targets outside MetaclawSession', () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-workspace-targets-'));
    const target = join(root, 'a/b/c');
    try {
      new WorkspaceTargetService().ensureTargets([target]);
      expect(() => new WorkspaceTargetService().ensureTargets([target])).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
