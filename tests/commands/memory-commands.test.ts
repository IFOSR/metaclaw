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

  it('lists recent auto-captured memories and supports undo', async () => {
    const pref = engine.addManual({
      content: '复杂方案默认先给结论',
      scope: 'global',
      type: 'domain',
    });
    db.prepare(`
      INSERT INTO memory_audit_events (
        id, task_id, memory_id, action, score, reason, judge_source, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'audit_capture_1',
      null,
      pref.id,
      'auto_capture',
      1,
      '用户明确长期偏好，低风险自动写入',
      'rule',
      JSON.stringify([{ sourceId: 'session:test' }]),
      '2026-05-20T00:00:00Z',
    );

    const recentResult = await memoryCommand.execute(['recent'], {
      memoryEngine: engine,
      db,
    } as any);
    expect(recentResult.content).toContain('最近记忆事件');
    expect(recentResult.content).toContain('auto_capture');
    expect(recentResult.content).toContain(pref.id);

    const autoCapturedResult = await memoryCommand.execute(['auto-captured'], {
      memoryEngine: engine,
      db,
    } as any);
    expect(autoCapturedResult.content).toContain('自动写入记忆');
    expect(autoCapturedResult.content).toContain('复杂方案默认先给结论');

    const undoResult = await memoryCommand.execute(['undo', pref.id], {
      memoryEngine: engine,
      db,
    } as any);
    expect(undoResult.content).toContain('已撤销记忆');
    expect(engine.list({ status: 'confirmed' })).toHaveLength(0);
  });

  it('lists auto-applied memory events by task', async () => {
    const pref = engine.addManual({
      content: 'MetaClaw 文档使用中文',
      scope: 'project',
      type: 'style',
      subject: 'MetaClaw',
    });
    db.prepare(`
      INSERT INTO memory_audit_events (
        id, task_id, memory_id, action, score, reason, judge_source, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'audit_apply_1',
      'task_demo',
      pref.id,
      'auto_apply',
      0.91,
      'LLM 判定当前任务明确相关',
      'llm',
      JSON.stringify([{ auditId: 'recall_1' }]),
      '2026-05-20T00:00:00Z',
    );

    const result = await memoryCommand.execute(['applied', 'task_demo'], {
      memoryEngine: engine,
      db,
    } as any);
    expect(result.content).toContain('已自动采用记忆');
    expect(result.content).toContain('task_demo');
    expect(result.content).toContain(pref.id);
    expect(result.content).toContain('score=0.91');
  });
});
