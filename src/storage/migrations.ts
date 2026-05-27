import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  up: string | ((db: Database.Database) => void);
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
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

        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_preferences_scope ON preferences(scope);
        CREATE INDEX IF NOT EXISTS idx_preferences_status ON preferences(status);
        CREATE INDEX IF NOT EXISTS idx_observations_pattern ON observations(pattern);
      `);
      addColumnIfMissing(db, 'tasks', 'snapshot_json', "TEXT DEFAULT '[]'");
      addColumnIfMissing(db, 'tasks', 'dependencies_json', "TEXT DEFAULT '[]'");
      addColumnIfMissing(db, 'tasks', 'priority_json', 'TEXT');
      addColumnIfMissing(db, 'tasks', 'injected_prefs_json', "TEXT DEFAULT '[]'");
    },
  },
  {
    version: 2,
    up: (db) => {
      addColumnIfMissing(db, 'interactions', 'session_id', 'TEXT');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_interactions_session ON interactions(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_interactions_task ON interactions(task_id, created_at);
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      addColumnIfMissing(db, 'tasks', 'last_scheduling_reason', "TEXT DEFAULT ''");
      addColumnIfMissing(db, 'tasks', 'last_interruption_reason', "TEXT DEFAULT ''");
      addColumnIfMissing(db, 'tasks', 'interruption_count', 'INTEGER DEFAULT 0');
    },
  },
  {
    version: 4,
    up: (db) => {
      addColumnIfMissing(db, 'tasks', 'artifacts_json', "TEXT DEFAULT '[]'");
    },
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

      CREATE INDEX IF NOT EXISTS idx_guidance_events_task ON guidance_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_task_relations_source ON task_relations(source_task_id, relation_type);
      CREATE INDEX IF NOT EXISTS idx_task_relations_target ON task_relations(target_task_id, relation_type);
      CREATE INDEX IF NOT EXISTS idx_task_memory_embeddings_task ON task_memory_embeddings(task_id, memory_kind);
      CREATE INDEX IF NOT EXISTS idx_preference_embeddings_preference ON preference_embeddings(preference_id);
      CREATE INDEX IF NOT EXISTS idx_memory_recall_events_task ON memory_recall_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_recall_review_policies_lookup
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
  {
    version: 7,
    up: `
      CREATE TABLE IF NOT EXISTS recall_feedback (
        id TEXT PRIMARY KEY,
        audit_id TEXT,
        query_task_id TEXT,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        action TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_recall_feedback_target
        ON recall_feedback(target_kind, target_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_recall_feedback_audit
        ON recall_feedback(audit_id, created_at);
    `,
  },
  {
    version: 8,
    up: `
      CREATE TABLE IF NOT EXISTS reflection_events (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT,
        task_id TEXT,
        summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS learning_candidates (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source_reflection_id TEXT,
        source_task_id TEXT,
        safety_status TEXT NOT NULL DEFAULT 'pending',
        safety_reasons_json TEXT NOT NULL DEFAULT '[]',
        review_note TEXT,
        promoted_asset_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_reflection_events_task
        ON reflection_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_reflection_events_source
        ON reflection_events(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_learning_candidates_status
        ON learning_candidates(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_learning_candidates_source_task
        ON learning_candidates(source_task_id, created_at);
    `,
  },
  {
    version: 9,
    up: `
      CREATE TABLE IF NOT EXISTS executor_skill_usage_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        executor_name TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        skill_version TEXT,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_skill_usage_events_task
        ON executor_skill_usage_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_skill_usage_events_execution
        ON executor_skill_usage_events(execution_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_skill_usage_events_skill
        ON executor_skill_usage_events(skill_name, event_type, created_at);
    `,
  },
  {
    version: 10,
    up: `
      CREATE TABLE IF NOT EXISTS executor_skill_install_events (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        package_id TEXT,
        executor_name TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_skill_install_events_candidate
        ON executor_skill_install_events(candidate_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_skill_install_events_executor
        ON executor_skill_install_events(executor_name, status, created_at);
    `,
  },
  {
    version: 11,
    up: `
      CREATE TABLE IF NOT EXISTS task_memory_cards (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        key_decisions_json TEXT NOT NULL DEFAULT '[]',
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        verification_commands_json TEXT NOT NULL DEFAULT '[]',
        pitfalls_json TEXT NOT NULL DEFAULT '[]',
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        outcome TEXT NOT NULL DEFAULT 'success',
        source_candidate_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_memory_cards_task
        ON task_memory_cards(task_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_task_memory_cards_source_candidate
        ON task_memory_cards(source_candidate_id);

      CREATE TABLE IF NOT EXISTS skill_effect_summaries (
        id TEXT PRIMARY KEY,
        executor_name TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        skill_version TEXT,
        skill_version_key TEXT GENERATED ALWAYS AS (COALESCE(skill_version, '')) STORED,
        used_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        helpful_count INTEGER NOT NULL DEFAULT 0,
        patch_candidate_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT NOT NULL,
        last_failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(executor_name, skill_name, skill_version_key)
      );

      CREATE INDEX IF NOT EXISTS idx_skill_effect_summaries_skill
        ON skill_effect_summaries(skill_name, skill_version_key, updated_at);
      CREATE INDEX IF NOT EXISTS idx_skill_effect_summaries_executor
        ON skill_effect_summaries(executor_name, used_count, updated_at);
    `,
  },
  {
    version: 12,
    up: `
      CREATE TABLE IF NOT EXISTS memory_audit_events (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        memory_id TEXT NOT NULL,
        action TEXT NOT NULL,
        score REAL,
        reason TEXT NOT NULL DEFAULT '',
        judge_source TEXT NOT NULL DEFAULT 'rule',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_audit_events_memory
        ON memory_audit_events(memory_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_audit_events_task
        ON memory_audit_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_audit_events_action
        ON memory_audit_events(action, created_at);
    `,
  },
  {
    version: 13,
    up: `
      CREATE TABLE IF NOT EXISTS executor_profiles (
        name TEXT PRIMARY KEY,
        domains_json TEXT NOT NULL DEFAULT '[]',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        input_types_json TEXT NOT NULL DEFAULT '[]',
        output_types_json TEXT NOT NULL DEFAULT '[]',
        strengths_json TEXT NOT NULL DEFAULT '[]',
        weaknesses_json TEXT NOT NULL DEFAULT '[]',
        primary_use_cases_json TEXT NOT NULL DEFAULT '[]',
        avoid_use_cases_json TEXT NOT NULL DEFAULT '[]',
        intent_affinity_json TEXT NOT NULL DEFAULT '{}',
        risk_level TEXT NOT NULL DEFAULT 'medium',
        availability TEXT NOT NULL DEFAULT 'available',
        historical_success REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS executor_route_events (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        user_input TEXT NOT NULL,
        selected_executor TEXT NOT NULL,
        action TEXT NOT NULL,
        candidates_json TEXT NOT NULL DEFAULT '[]',
        primary_intent TEXT NOT NULL DEFAULT 'general',
        matched_boundary_json TEXT NOT NULL DEFAULT '[]',
        rejected_json TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL DEFAULT '',
        confirmed_by_user INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_executor_route_events_executor
        ON executor_route_events(selected_executor, created_at);
      CREATE INDEX IF NOT EXISTS idx_executor_route_events_task
        ON executor_route_events(task_id, created_at);
    `,
  },
];

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some(row => row.name === column);
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  if (columnExists(db, table, column)) {
    return;
  }

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function runMigration(db: Database.Database, migration: Migration): void {
  if (typeof migration.up === 'string') {
    db.exec(migration.up);
    return;
  }

  migration.up(db);
}

/**
 * 运行数据库迁移
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);

  const result = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  const currentVersion = result?.v ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      runMigration(db, migration);
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(migration.version);
    }
  }

  addColumnIfMissing(db, 'executor_profiles', 'primary_use_cases_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'executor_profiles', 'avoid_use_cases_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'executor_profiles', 'intent_affinity_json', "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, 'executor_route_events', 'primary_intent', "TEXT NOT NULL DEFAULT 'general'");
  addColumnIfMissing(db, 'executor_route_events', 'matched_boundary_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'executor_route_events', 'rejected_json', "TEXT NOT NULL DEFAULT '[]'");
}
