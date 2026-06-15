import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';

describe('runMigrations', () => {
  it('repairs a legacy v1 database whose schema_version table is empty', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        summary TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        block_reason TEXT,
        next_step TEXT,
        resources_json TEXT DEFAULT '[]'
      );

      CREATE TABLE preferences (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        subject TEXT,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'observed',
        confidence REAL DEFAULT 0,
        occurrence_count INTEGER DEFAULT 1,
        source_tasks TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        confirmed_at TEXT
      );

      CREATE TABLE preference_usage (
        id TEXT PRIMARY KEY,
        preference_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        injected_at TEXT NOT NULL,
        was_overridden INTEGER DEFAULT 0
      );

      CREATE TABLE observations (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        occurrence_count INTEGER DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        source_tasks TEXT DEFAULT '[]',
        promoted_to_preference_id TEXT
      );

      CREATE TABLE interactions (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        user_input TEXT,
        system_output TEXT,
        executor_used TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_tasks_status ON tasks(status);
    `);

    expect(() => runMigrations(db)).not.toThrow();

    const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>;
    expect(versions.map(row => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    expect(taskColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'snapshot_json',
      'dependencies_json',
      'priority_json',
      'injected_prefs_json',
      'last_scheduling_reason',
      'last_interruption_reason',
      'interruption_count',
      'artifacts_json',
    ]));

    const auditColumns = db.prepare('PRAGMA table_info(memory_audit_events)').all() as Array<{ name: string }>;
    expect(auditColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'id',
      'task_id',
      'memory_id',
      'action',
      'score',
      'reason',
      'judge_source',
      'evidence_json',
      'created_at',
    ]));

    const executorProfileColumns = db.prepare('PRAGMA table_info(executor_profiles)').all() as Array<{ name: string }>;
    expect(executorProfileColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'name',
      'domains_json',
      'capabilities_json',
      'risk_level',
      'historical_success',
      'runtime_command',
      'runtime_args_json',
      'runtime_check_command',
      'project_url',
    ]));

    const taskSearchIndexColumns = db.prepare('PRAGMA table_info(task_search_index)').all() as Array<{ name: string }>;
    expect(taskSearchIndexColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'task_id',
      'source_kind',
      'source_id',
      'title',
      'body',
      'tags',
      'created_at',
      'updated_at',
    ]));

    const repo = new TaskRepo(db);
    repo.insert({
      id: 'task_legacy_repaired',
      title: 'legacy repaired',
      goal: 'verify repo can write after migration repair',
      status: 'created',
      summary: '',
      snapshots: [],
      resources: [],
      artifacts: [],
      dependencies: [],
      prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
      injectedPreferences: [],
      lastSchedulingReason: '',
      lastInterruptionReason: '',
      interruptionCount: 0,
      createdAt: '2026-04-25T00:00:00.000Z',
      updatedAt: '2026-04-25T00:00:00.000Z',
    });

    expect(repo.findById('task_legacy_repaired')?.title).toBe('legacy repaired');
  });
});
