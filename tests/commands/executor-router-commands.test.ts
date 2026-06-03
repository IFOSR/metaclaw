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
  it('lists, registers, and unregisters executor profiles from the command surface', async () => {
    const db = createDb();
    const context = {
      db,
      executor: { name: 'codex-cli' },
    } as any;

    const initial = await executorCommand.execute(['list'], context);
    expect(initial.content).toContain('已注册 Executors');
    expect(initial.content).toContain('codex-cli');

    const register = await executorCommand.execute([
      'register',
      'research-bot',
      '--command',
      'research-bot',
      '--args',
      'run --prompt {prompt}',
      '--check',
      'research-bot --version',
      '--domains',
      'research,reporting',
      '--capabilities',
      'research,report_generation',
      '--inputs',
      'text,files',
      '--outputs',
      'markdown,report',
      '--risk',
      'low',
      '--success',
      '0.8',
    ], context);
    expect(register.content).toBe('已注册 Executor：research-bot');

    const afterRegister = await executorCommand.execute(['list'], context);
    expect(afterRegister.content).toContain('research-bot');
    expect(afterRegister.content).toContain('status=available');
    expect(afterRegister.content).toContain('capabilities=research,report_generation');
    expect(afterRegister.content).toContain('runtime=research-bot run --prompt {prompt}');

    const unregister = await executorCommand.execute(['unregister', 'research-bot'], context);
    expect(unregister.content).toBe('已反注册 Executor：research-bot');

    const afterUnregister = await executorCommand.execute(['list'], context);
    expect(afterUnregister.content).toContain('research-bot');
    expect(afterUnregister.content).toContain('status=unavailable');
  });

  it('does not route to an unregistered executor', async () => {
    const db = createDb();
    const context = {
      db,
      executor: { name: 'codex-cli' },
    } as any;

    await executorCommand.execute([
      'register',
      'legal-contract',
      '--domains',
      'legal,contract',
      '--capabilities',
      'contract_review,risk_matrix',
      '--primary-use-cases',
      '审查合同条款',
      '--success',
      '0.95',
    ], context);

    const before = await executorCommand.execute(['route', '请审查合同条款并输出风险矩阵'], context);
    expect(before.content).toContain('Route Decision：legal-contract');

    await executorCommand.execute(['unregister', 'legal-contract'], context);

    const after = await executorCommand.execute(['route', '请审查合同条款并输出风险矩阵'], context);
    expect(after.content).not.toContain('Route Decision：legal-contract');
  });

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
