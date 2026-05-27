import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { ExecutorProfileRepo } from '../../src/storage/executor-profile-repo.js';
import { seedDefaultExecutorProfiles } from '../../src/core/executor-registry-seeder.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('seedDefaultExecutorProfiles', () => {
  it('registers active local known executors exactly once without retired route registrations', () => {
    const db = createDb();
    const repo = new ExecutorProfileRepo(db);
    repo.upsert({
      name: 'openclaw',
      domains: ['gateway'],
      capabilities: ['message_delivery'],
      inputTypes: ['text'],
      outputTypes: ['json'],
      strengths: [],
      weaknesses: [],
      riskLevel: 'high',
      availability: 'available',
      historicalSuccess: 0.5,
    });

    seedDefaultExecutorProfiles(repo, {
      defaultExecutorName: 'codex-cli',
      availableCommands: new Set(['codex', 'claude', 'hermes', 'openclaw', 'deepseek-tui']),
    });
    seedDefaultExecutorProfiles(repo, {
      defaultExecutorName: 'codex-cli',
      availableCommands: new Set(['codex', 'claude', 'hermes', 'openclaw', 'deepseek-tui']),
    });

    const profiles = repo.findAll();
    expect(profiles.map(profile => profile.name).sort()).toEqual([
      'codex-cli',
      'deepseek-tui',
      'hermes-agent',
    ]);
    expect(profiles.some(profile => profile.name === 'openclaw')).toBe(false);
    expect(profiles.some(profile => profile.name === 'claude-code')).toBe(false);
    expect(profiles.find(profile => profile.name === 'codex-cli')).toEqual(expect.objectContaining({
      availability: 'available',
      domains: expect.arrayContaining(['software', 'repo', 'terminal']),
      capabilities: expect.arrayContaining(['coding', 'tests', 'debugging', 'code_review', 'noninteractive_execution']),
    }));
    expect(profiles.find(profile => profile.name === 'hermes-agent')).toEqual(expect.objectContaining({
      domains: expect.arrayContaining(['personal_assistant', 'research', 'automation', 'messaging', 'memory']),
      capabilities: expect.arrayContaining(['persistent_memory', 'multi_tool', 'skill_runtime', 'messaging_gateway']),
    }));
    expect(profiles.find(profile => profile.name === 'deepseek-tui')).toEqual(expect.objectContaining({
      availability: 'available',
      domains: expect.arrayContaining(['software', 'repo', 'reasoning', 'algorithm', 'chinese_analysis']),
      capabilities: expect.arrayContaining(['coding', 'code_review', 'deepseek_reasoning', 'agentic_tui']),
    }));
  });
});
