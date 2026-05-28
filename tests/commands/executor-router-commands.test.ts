import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { executorCommand } from '../../src/commands/executor-commands.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('executor registry and route commands', () => {
  it('upserts executor profiles, routes tasks, and records route feedback', async () => {
    const db = createDb();
    const context = {
      db,
      executor: { name: 'codex-cli' },
    } as any;

    await executorCommand.execute([
      'profile',
      'upsert',
      'legal-contract',
      '--domains',
      'legal,contract',
      '--capabilities',
      'contract_review,risk_matrix',
      '--risk',
      'high',
      '--success',
      '0.9',
    ], context);

    const profiles = await executorCommand.execute(['profiles'], context);
    expect(profiles.content).toContain('legal-contract');
    expect(profiles.content).toContain('legal');

    const route = await executorCommand.execute(['route', '请审查合同条款并输出风险矩阵'], context);
    expect(route.content).toContain('legal-contract');
    expect(route.content).toContain('fallback_default');

    const feedback = await executorCommand.execute(['route-feedback'], context);
    expect(feedback.content).toContain('legal-contract');
    expect(feedback.content).toContain('请审查合同条款');
  });
});
