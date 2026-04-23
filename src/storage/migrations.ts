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
  {
    version: 4,
    up: `
      ALTER TABLE tasks ADD COLUMN artifacts_json TEXT DEFAULT '[]';
    `,
  },
  {
    version: 5,
    up: `
      CREATE TABLE IF NOT EXISTS guidance_events (
        id TEXT PRIMARY KEY,
        trigger TEXT NOT NULL,
        task_id TEXT,
        action_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        reasons_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL DEFAULT 0,
        requires_confirmation INTEGER DEFAULT 1,
        accepted_at TEXT,
        dismissed_at TEXT,
        executed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_relations (
        id TEXT PRIMARY KEY,
        source_task_id TEXT NOT NULL,
        target_task_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_memory_embeddings (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        memory_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS preference_embeddings (
        id TEXT PRIMARY KEY,
        preference_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_recall_events (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        query_text TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        task_candidates_json TEXT NOT NULL DEFAULT '[]',
        preference_candidates_json TEXT NOT NULL DEFAULT '[]',
        review_summary_json TEXT NOT NULL DEFAULT '{}',
        accepted_candidates_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recall_review_policies (
        id TEXT PRIMARY KEY,
        policy_type TEXT NOT NULL,
        scope TEXT,
        subject TEXT,
        proposal_type TEXT,
        auto_apply INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_guidance_events_task ON guidance_events(task_id, created_at);
      CREATE INDEX idx_task_relations_source ON task_relations(source_task_id, relation_type);
      CREATE INDEX idx_task_relations_target ON task_relations(target_task_id, relation_type);
      CREATE INDEX idx_task_memory_embeddings_task ON task_memory_embeddings(task_id, memory_kind);
      CREATE INDEX idx_preference_embeddings_preference ON preference_embeddings(preference_id);
      CREATE INDEX idx_memory_recall_events_task ON memory_recall_events(task_id, created_at);
      CREATE INDEX idx_recall_review_policies_lookup
        ON recall_review_policies(policy_type, scope, subject, proposal_type);
    `,
  },
  {
    version: 6,
    up: `
      CREATE TABLE IF NOT EXISTS session_state (
        id TEXT PRIMARY KEY,
        last_focused_task_id TEXT,
        last_completed_task_id TEXT,
        last_session_id TEXT,
        updated_at TEXT NOT NULL
      );
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
