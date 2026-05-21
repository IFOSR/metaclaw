import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryEngine } from '../../src/core/memory-engine.js';
import { memoryCommand } from '../../src/commands/memory-commands.js';
import { profileCommand } from '../../src/commands/profile-commands.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('memory graph and vault commands', () => {
  let db: Database.Database;
  let memoryEngine: MemoryEngine;
  let prefId: string;

  beforeEach(() => {
    db = createTestDb();
    memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const pref = memoryEngine.addManual({
      content: 'MetaClaw 文档默认使用中文，并保留执行证据',
      scope: 'project',
      type: 'style',
      subject: 'MetaClaw',
    });
    prefId = pref.id;

    db.prepare(`
      INSERT INTO memory_audit_events (
        id, task_id, memory_id, action, score, reason, judge_source, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'audit_graph_1',
      'task_graph_1',
      pref.id,
      'auto_apply',
      0.91,
      'LLM 判定当前 MetaClaw 文档任务明确相关',
      'llm',
      JSON.stringify([{ sourceId: 'recall_1', quote: '默认使用中文' }]),
      '2026-05-21T00:00:00.000Z',
    );
  });

  it('explains evidence, timeline, and relations for a memory', async () => {
    const context = { memoryEngine, db } as any;

    const explain = await memoryCommand.execute(['explain', prefId], context);
    expect(explain.content).toContain(prefId);
    expect(explain.content).toContain('MetaClaw 文档默认使用中文');
    expect(explain.content).toContain('LLM 判定当前 MetaClaw 文档任务明确相关');

    const evidence = await memoryCommand.execute(['evidence', prefId], context);
    expect(evidence.content).toContain('recall_1');
    expect(evidence.content).toContain('默认使用中文');

    const timeline = await memoryCommand.execute(['timeline'], context);
    expect(timeline.content).toContain('auto_apply');
    expect(timeline.content).toContain(prefId);

    const relations = await memoryCommand.execute(['relations', prefId], context);
    expect(relations.content).toContain('task_graph_1');
    expect(relations.content).toContain('audit_graph_1');
  });

  it('shows user and project profiles from local memory graph assets', async () => {
    const userProfile = await profileCommand.execute(['user'], { memoryEngine, db, executor: { name: 'codex-cli' } } as any);
    expect(userProfile.content).toContain('用户工作画像');
    expect(userProfile.content).toContain('长期记忆 1');

    const projectProfile = await profileCommand.execute(['project', 'MetaClaw'], { memoryEngine, db } as any);
    expect(projectProfile.content).toContain('项目画像：MetaClaw');
    expect(projectProfile.content).toContain('MetaClaw 文档默认使用中文');
  });

  it('exports a readable one-way Markdown vault', async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), 'metaclaw-vault-'));

    const exportResult = await memoryCommand.execute(['vault', 'export', '--dir', vaultDir], {
      memoryEngine,
      db,
    } as any);
    expect(exportResult.content).toContain('Vault 导出完成');

    expect(existsSync(join(vaultDir, 'README.md'))).toBe(true);
    expect(existsSync(join(vaultDir, 'preferences', `${prefId}.md`))).toBe(true);
    expect(existsSync(join(vaultDir, 'evidence', 'audit_graph_1.md'))).toBe(true);
    expect(existsSync(join(vaultDir, 'timelines', 'memory.md'))).toBe(true);
    expect(existsSync(join(vaultDir, 'profiles', 'user.md'))).toBe(true);

    const prefMarkdown = readFileSync(join(vaultDir, 'preferences', `${prefId}.md`), 'utf8');
    expect(prefMarkdown).toContain('scope: project');
    expect(prefMarkdown).toContain('MetaClaw 文档默认使用中文');

    const statusResult = await memoryCommand.execute(['vault', 'status', '--dir', vaultDir], {
      memoryEngine,
      db,
    } as any);
    expect(statusResult.content).toContain('preferences=1');
    expect(statusResult.content).toContain('evidence=1');
  });
});
