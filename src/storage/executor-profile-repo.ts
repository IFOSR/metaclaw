import type Database from 'better-sqlite3';
import type { ExecutorAvailability, ExecutorProfile, ExecutorRiskLevel, TaskRouteIntent } from '../core/executor-router.js';

interface ExecutorProfileRow {
  name: string;
  domains_json: string;
  capabilities_json: string;
  input_types_json: string;
  output_types_json: string;
  strengths_json: string;
  weaknesses_json: string;
  primary_use_cases_json?: string;
  avoid_use_cases_json?: string;
  intent_affinity_json?: string;
  risk_level: ExecutorRiskLevel;
  availability: ExecutorAvailability;
  historical_success: number;
  runtime_command?: string | null;
  runtime_args_json?: string | null;
  runtime_check_command?: string | null;
  project_url?: string | null;
  created_at: string;
  updated_at: string;
}

function parseList(value: string): string[] {
  return JSON.parse(value || '[]') as string[];
}

function parseIntentAffinity(value: string | undefined): Partial<Record<TaskRouteIntent, number>> {
  return JSON.parse(value || '{}') as Partial<Record<TaskRouteIntent, number>>;
}

function rowToProfile(row: ExecutorProfileRow): ExecutorProfile {
  return {
    name: row.name,
    domains: parseList(row.domains_json),
    capabilities: parseList(row.capabilities_json),
    inputTypes: parseList(row.input_types_json),
    outputTypes: parseList(row.output_types_json),
    strengths: parseList(row.strengths_json),
    weaknesses: parseList(row.weaknesses_json),
    primaryUseCases: parseList(row.primary_use_cases_json ?? '[]'),
    avoidUseCases: parseList(row.avoid_use_cases_json ?? '[]'),
    intentAffinity: parseIntentAffinity(row.intent_affinity_json),
    riskLevel: row.risk_level,
    availability: row.availability,
    historicalSuccess: row.historical_success,
    runtimeCommand: row.runtime_command ?? null,
    runtimeArgs: parseList(row.runtime_args_json ?? '[]'),
    runtimeCheckCommand: row.runtime_check_command ?? null,
    projectUrl: row.project_url ?? null,
  };
}

export class ExecutorProfileRepo {
  constructor(private db: Database.Database) {}

  upsert(profile: ExecutorProfile): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO executor_profiles (
        name, domains_json, capabilities_json, input_types_json, output_types_json,
        strengths_json, weaknesses_json, primary_use_cases_json, avoid_use_cases_json,
        intent_affinity_json, risk_level, availability, historical_success,
        runtime_command, runtime_args_json, runtime_check_command, project_url,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        domains_json = excluded.domains_json,
        capabilities_json = excluded.capabilities_json,
        input_types_json = excluded.input_types_json,
        output_types_json = excluded.output_types_json,
        strengths_json = excluded.strengths_json,
        weaknesses_json = excluded.weaknesses_json,
        primary_use_cases_json = excluded.primary_use_cases_json,
        avoid_use_cases_json = excluded.avoid_use_cases_json,
        intent_affinity_json = excluded.intent_affinity_json,
        risk_level = excluded.risk_level,
        availability = excluded.availability,
        historical_success = excluded.historical_success,
        runtime_command = excluded.runtime_command,
        runtime_args_json = excluded.runtime_args_json,
        runtime_check_command = excluded.runtime_check_command,
        project_url = excluded.project_url,
        updated_at = excluded.updated_at
    `).run(
      profile.name,
      JSON.stringify(profile.domains),
      JSON.stringify(profile.capabilities),
      JSON.stringify(profile.inputTypes),
      JSON.stringify(profile.outputTypes),
      JSON.stringify(profile.strengths),
      JSON.stringify(profile.weaknesses),
      JSON.stringify(profile.primaryUseCases ?? []),
      JSON.stringify(profile.avoidUseCases ?? []),
      JSON.stringify(profile.intentAffinity ?? {}),
      profile.riskLevel,
      profile.availability,
      profile.historicalSuccess,
      profile.runtimeCommand ?? null,
      JSON.stringify(profile.runtimeArgs ?? []),
      profile.runtimeCheckCommand ?? null,
      profile.projectUrl ?? null,
      now,
      now,
    );
  }

  findAll(): ExecutorProfile[] {
    const rows = this.db.prepare('SELECT * FROM executor_profiles ORDER BY name ASC').all() as ExecutorProfileRow[];
    return rows.map(rowToProfile);
  }

  findByName(name: string): ExecutorProfile | null {
    const row = this.db.prepare('SELECT * FROM executor_profiles WHERE name = ?').get(name) as ExecutorProfileRow | undefined;
    return row ? rowToProfile(row) : null;
  }

  deleteByName(name: string): void {
    this.db.prepare('DELETE FROM executor_profiles WHERE name = ?').run(name);
  }
}
