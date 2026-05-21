import type Database from 'better-sqlite3';
import type { ExecutorAvailability, ExecutorProfile, ExecutorRiskLevel } from '../core/executor-router.js';

interface ExecutorProfileRow {
  name: string;
  domains_json: string;
  capabilities_json: string;
  input_types_json: string;
  output_types_json: string;
  strengths_json: string;
  weaknesses_json: string;
  risk_level: ExecutorRiskLevel;
  availability: ExecutorAvailability;
  historical_success: number;
  created_at: string;
  updated_at: string;
}

function parseList(value: string): string[] {
  return JSON.parse(value || '[]') as string[];
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
    riskLevel: row.risk_level,
    availability: row.availability,
    historicalSuccess: row.historical_success,
  };
}

export class ExecutorProfileRepo {
  constructor(private db: Database.Database) {}

  upsert(profile: ExecutorProfile): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO executor_profiles (
        name, domains_json, capabilities_json, input_types_json, output_types_json,
        strengths_json, weaknesses_json, risk_level, availability, historical_success,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        domains_json = excluded.domains_json,
        capabilities_json = excluded.capabilities_json,
        input_types_json = excluded.input_types_json,
        output_types_json = excluded.output_types_json,
        strengths_json = excluded.strengths_json,
        weaknesses_json = excluded.weaknesses_json,
        risk_level = excluded.risk_level,
        availability = excluded.availability,
        historical_success = excluded.historical_success,
        updated_at = excluded.updated_at
    `).run(
      profile.name,
      JSON.stringify(profile.domains),
      JSON.stringify(profile.capabilities),
      JSON.stringify(profile.inputTypes),
      JSON.stringify(profile.outputTypes),
      JSON.stringify(profile.strengths),
      JSON.stringify(profile.weaknesses),
      profile.riskLevel,
      profile.availability,
      profile.historicalSuccess,
      now,
      now,
    );
  }

  findAll(): ExecutorProfile[] {
    const rows = this.db.prepare('SELECT * FROM executor_profiles ORDER BY name ASC').all() as ExecutorProfileRow[];
    return rows.map(rowToProfile);
  }

  deleteByName(name: string): void {
    this.db.prepare('DELETE FROM executor_profiles WHERE name = ?').run(name);
  }
}
