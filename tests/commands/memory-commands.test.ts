import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryEngine } from '../../src/core/memory-engine.js';
import { memoryCommand } from '../../src/commands/memory-commands.js';
import { RecallReviewPolicyRepo } from '../../src/storage/recall-review-policy-repo.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('memoryCommand', () => {
  let engine: MemoryEngine;
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    engine = new MemoryEngine(prefRepo, obsRepo);
  });

  it('supports editing an existing preference', async () => {
    const pref = engine.addManual({
      content: '输出用 Markdown 格式',
      scope: 'global',
      type: 'style',
    });

    const result = await memoryCommand.execute(['edit', pref.id, '输出用表格格式'], {
      memoryEngine: engine,
    } as any);

    expect(result.content).toContain('已更新偏好');
    expect(engine.list()[0].content).toBe('输出用表格格式');
  });

  it('supports adding a scoped preference with subject flags', async () => {
    const result = await memoryCommand.execute([
      'add',
      '--scope',
      'contact',
      '--type',
      'contact',
      '--subject',
      '张总',
      '给张总的邮件用正式语气',
    ], {
      memoryEngine: engine,
    } as any);

    expect(result.content).toContain('已添加偏好');

    const pref = engine.list()[0];
    expect(pref.scope).toBe('contact');
    expect(pref.type).toBe('contact');
    expect(pref.subject).toBe('张总');
    expect(pref.content).toBe('给张总的邮件用正式语气');
  });

  it('supports editing scope and subject for an existing preference', async () => {
    const pref = engine.addManual({
      content: '当前任务保留表格结构',
      scope: 'global',
      type: 'style',
    });

    const result = await memoryCommand.execute([
      'edit',
      pref.id,
      '--scope',
      'task-local',
      '--type',
      'style',
      '--subject',
      'task_demo123',
      '当前任务保留表格结构并增加风险栏目',
    ], {
      memoryEngine: engine,
    } as any);

    expect(result.content).toContain('已更新偏好');

    const updated = engine.list()[0];
    expect(updated.scope).toBe('task-local');
    expect(updated.subject).toBe('task_demo123');
    expect(updated.content).toBe('当前任务保留表格结构并增加风险栏目');
  });

  it('shows scope and subject in the default memory list output', async () => {
    engine.addManual({
      content: 'Phoenix 项目统一使用 Phoenix 术语',
      scope: 'project',
      type: 'domain',
      subject: 'Phoenix',
    });

    const result = await memoryCommand.execute([], {
      memoryEngine: engine,
    } as any);

    expect(result.content).toContain('[project]');
    expect(result.content).toContain('(Phoenix)');
    expect(result.content).toContain('Phoenix 项目统一使用 Phoenix 术语');
  });

  it('lists and revokes recall review policies', async () => {
    const repo = new RecallReviewPolicyRepo(db);
    repo.upsert({
      id: 'policy:proposal:resume_task',
      policyType: 'proposal_type',
      scope: null,
      subject: null,
      proposalType: 'resume_task',
      autoApply: true,
      createdAt: '2026-04-20T00:00:00Z',
      updatedAt: '2026-04-20T00:00:00Z',
    });

    const listResult = await memoryCommand.execute(['review-policy'], {
      memoryEngine: engine,
      db,
    } as any);
    expect(listResult.content).toContain('Recall Review Policies');
    expect(listResult.content).toContain('proposal_type');
    expect(listResult.content).toContain('resume_task');

    const revokeResult = await memoryCommand.execute(['review-policy', 'revoke', 'policy:proposal:resume_task'], {
      memoryEngine: engine,
      db,
    } as any);
    expect(revokeResult.content).toContain('已撤销');

    const listAfterRevoke = await memoryCommand.execute(['review-policy'], {
      memoryEngine: engine,
      db,
    } as any);
    expect(listAfterRevoke.content).toContain('暂无 recall review policy');
  });
});
