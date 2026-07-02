import type Database from 'better-sqlite3';
import type { AgentClass, AgentClassAvailability, AgentClassKind, AgentClassRiskLevel } from '../core/types.js';

interface AgentClassRow {
  name: string;
  kind: AgentClassKind;
  domains_json: string;
  capabilities_json: string;
  input_types_json: string;
  output_types_json: string;
  strengths_json: string;
  weaknesses_json: string;
  primary_use_cases_json: string;
  avoid_use_cases_json: string;
  intent_affinity_json: string;
  risk_level: AgentClassRiskLevel;
  availability: AgentClassAvailability;
  historical_success: number;
  harness: string | null;
  model: string | null;
  skills_json: string;
  mcp_servers_json: string;
  plugins_json: string;
  runtime_command: string | null;
  runtime_args_json: string;
  runtime_check_command: string | null;
  project_url: string | null;
  created_at: string;
  updated_at: string;
}

function parseList(value: string | null | undefined): string[] {
  return JSON.parse(value || '[]') as string[];
}

function parseAffinity(value: string | null | undefined): Record<string, number> {
  return JSON.parse(value || '{}') as Record<string, number>;
}

function rowToAgentClass(row: AgentClassRow): AgentClass {
  return {
    name: row.name,
    kind: row.kind,
    domains: parseList(row.domains_json),
    capabilities: parseList(row.capabilities_json),
    inputTypes: parseList(row.input_types_json),
    outputTypes: parseList(row.output_types_json),
    strengths: parseList(row.strengths_json),
    weaknesses: parseList(row.weaknesses_json),
    primaryUseCases: parseList(row.primary_use_cases_json),
    avoidUseCases: parseList(row.avoid_use_cases_json),
    intentAffinity: parseAffinity(row.intent_affinity_json),
    riskLevel: row.risk_level,
    availability: row.availability,
    historicalSuccess: row.historical_success,
    harness: row.harness,
    model: row.model,
    skills: parseList(row.skills_json),
    mcpServers: parseList(row.mcp_servers_json),
    plugins: parseList(row.plugins_json),
    runtimeCommand: row.runtime_command,
    runtimeArgs: parseList(row.runtime_args_json),
    runtimeCheckCommand: row.runtime_check_command,
    projectUrl: row.project_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AgentClassRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(agentClass: AgentClass): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_classes (
        name, kind, domains_json, capabilities_json, input_types_json, output_types_json,
        strengths_json, weaknesses_json, primary_use_cases_json, avoid_use_cases_json,
        intent_affinity_json, risk_level, availability, historical_success, harness, model,
        skills_json, mcp_servers_json, plugins_json, runtime_command, runtime_args_json,
        runtime_check_command, project_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        kind = excluded.kind,
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
        harness = excluded.harness,
        model = excluded.model,
        skills_json = excluded.skills_json,
        mcp_servers_json = excluded.mcp_servers_json,
        plugins_json = excluded.plugins_json,
        runtime_command = excluded.runtime_command,
        runtime_args_json = excluded.runtime_args_json,
        runtime_check_command = excluded.runtime_check_command,
        project_url = excluded.project_url,
        updated_at = excluded.updated_at
    `).run(
      agentClass.name,
      agentClass.kind,
      JSON.stringify(agentClass.domains),
      JSON.stringify(agentClass.capabilities),
      JSON.stringify(agentClass.inputTypes),
      JSON.stringify(agentClass.outputTypes),
      JSON.stringify(agentClass.strengths),
      JSON.stringify(agentClass.weaknesses),
      JSON.stringify(agentClass.primaryUseCases),
      JSON.stringify(agentClass.avoidUseCases),
      JSON.stringify(agentClass.intentAffinity),
      agentClass.riskLevel,
      agentClass.availability,
      agentClass.historicalSuccess,
      agentClass.harness,
      agentClass.model,
      JSON.stringify(agentClass.skills),
      JSON.stringify(agentClass.mcpServers),
      JSON.stringify(agentClass.plugins),
      agentClass.runtimeCommand,
      JSON.stringify(agentClass.runtimeArgs),
      agentClass.runtimeCheckCommand,
      agentClass.projectUrl,
      agentClass.createdAt ?? now,
      now,
    );
  }

  findAll(): AgentClass[] {
    const rows = this.db.prepare('SELECT * FROM agent_classes ORDER BY kind ASC, name ASC').all() as AgentClassRow[];
    return rows.map(rowToAgentClass);
  }

  findByKind(kind: AgentClassKind): AgentClass[] {
    const rows = this.db.prepare('SELECT * FROM agent_classes WHERE kind = ? ORDER BY name ASC').all(kind) as AgentClassRow[];
    return rows.map(rowToAgentClass);
  }

  findByName(name: string): AgentClass | null {
    const row = this.db.prepare('SELECT * FROM agent_classes WHERE name = ?').get(name) as AgentClassRow | undefined;
    return row ? rowToAgentClass(row) : null;
  }
}
