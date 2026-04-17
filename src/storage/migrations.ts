import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        summary TEXT DEFAULT '',
        snapshot_json TEXT DEFAULT '[]',
        resources_json TEXT DEFAULT '[]',
        dependencies_json TEXT DEFAULT '[]',
        priority_json TEXT,
        injected_prefs_json TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS preferences (
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

      CREATE TABLE IF NOT EXISTS preference_usage (
        id TEXT PRIMARY KEY,
        preference_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        injected_at TEXT NOT NULL,
        was_overridden INTEGER DEFAULT 0,
        FOREIGN KEY (preference_id) REFERENCES preferences(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        occurrence_count INTEGER DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        source_tasks TEXT DEFAULT '[]',
        promoted_to_preference_id TEXT
      );

      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        user_input TEXT,
        system_output TEXT,
        executor_used TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_tasks_status ON tasks(status);
      CREATE INDEX idx_preferences_scope ON preferences(scope);
      CREATE INDEX idx_preferences_status ON preferences(status);
      CREATE INDEX idx_observations_pattern ON observations(pattern);
    `,
  },
  {
    version: 2,
    up: `
      ALTER TABLE interactions ADD COLUMN session_id TEXT;
      CREATE INDEX idx_interactions_session ON interactions(session_id, created_at);
      CREATE INDEX idx_interactions_task ON interactions(task_id, created_at);
    `,
  },
  {
    version: 3,
    up: `
      ALTER TABLE tasks ADD COLUMN last_scheduling_reason TEXT DEFAULT '';
      ALTER TABLE tasks ADD COLUMN last_interruption_reason TEXT DEFAULT '';
      ALTER TABLE tasks ADD COLUMN interruption_count INTEGER DEFAULT 0;
    `,
  },
];

/**
 * 运行数据库迁移
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);

  const result = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  const currentVersion = result?.v ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      db.exec(migration.up);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
    }
  }
}
