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
      availableCommands: new Set(['codex', 'claude', 'hermes', 'openclaw', 'deepseek-tui', 'pi']),
    });
    seedDefaultExecutorProfiles(repo, {
      defaultExecutorName: 'codex-cli',
      availableCommands: new Set(['codex', 'claude', 'hermes', 'openclaw', 'deepseek-tui', 'pi']),
    });

    const profiles = repo.findAll();
    expect(profiles.map(profile => profile.name).sort()).toEqual([
      'codex-cli',
      'hermes-agent',
      'pi-agent',
    ]);
    expect(profiles.some(profile => profile.name === 'openclaw')).toBe(false);
    expect(profiles.some(profile => profile.name === 'claude-code')).toBe(false);
    expect(profiles.some(profile => profile.name === 'deepseek-tui')).toBe(false);
    expect(profiles.find(profile => profile.name === 'codex-cli')).toEqual(expect.objectContaining({
      availability: 'available',
      domains: expect.arrayContaining(['software', 'repo', 'terminal']),
      capabilities: expect.arrayContaining(['coding', 'tests', 'debugging', 'code_review', 'noninteractive_execution']),
    }));
    expect(profiles.find(profile => profile.name === 'pi-agent')).toEqual(expect.objectContaining({
      availability: 'available',
      domains: expect.arrayContaining(['research', 'automation', 'agent_ops', 'reporting']),
      capabilities: expect.arrayContaining(['research', 'multi_tool', 'workflow_automation', 'report_generation']),
    }));
    expect(profiles.find(profile => profile.name === 'hermes-agent')).toEqual(expect.objectContaining({
      availability: 'available',
      domains: expect.arrayContaining(['research', 'automation', 'agent_ops']),
      capabilities: expect.arrayContaining(['research', 'multi_tool', 'workflow_automation']),
    }));
  });
});
