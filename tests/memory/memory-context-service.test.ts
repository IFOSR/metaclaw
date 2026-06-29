import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { ResumeContextBuilder } from '../../src/memory/resume-context-builder.js';
import { MemoryContextService } from '../../src/memory/memory-context-service.js';
import type { ExecutionContextBundleV2 } from '../../src/core/types.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('MemoryContextService', () => {
  let db: Database.Database;
  let taskRepo: TaskRepo;
  let taskEngine: TaskEngine;
  let memoryEngine: MemoryEngine;
  let contextRecaller: ContextRecaller;
  let service: MemoryContextService;

  beforeEach(() => {
    db = createTestDb();
    taskRepo = new TaskRepo(db);
    taskEngine = new TaskEngine(taskRepo, resolve(tmpdir(), 'metaclaw-memory-context-tests'));
    memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    contextRecaller = new ContextRecaller(db);
    service = new MemoryContextService({
      memoryEngine,
      contextRecaller,
      resumeContextBuilder: new ResumeContextBuilder(taskEngine, memoryEngine, contextRecaller),
    });
  });

  function insertInteraction(input: {
    id: string;
    taskId: string | null;
    sessionId: string;
    userInput: string;
    systemOutput: string;
    createdAt: string;
  }) {
    db.prepare(
      'INSERT INTO interactions (id, task_id, session_id, user_input, system_output, executor_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(input.id, input.taskId, input.sessionId, input.userInput, input.systemOutput, 'codex-cli', input.createdAt);
  }

  it('builds execution context with preferences, history, and resume bundle through one service', async () => {
    const task = taskEngine.create({ title: 'Phoenix 周报', goal: '整理 Phoenix 周报' });
    const pref = memoryEngine.addManual({
      content: '凡是周报默认输出 Markdown',
      scope: 'global',
      type: 'workflow',
    });
    insertInteraction({
      id: 'int_1',
      taskId: task.id,
      sessionId: 'sess_1',
      userInput: '先整理经营数据',
      systemOutput: '经营数据已整理',
      createdAt: '2026-04-16T00:00:00Z',
    });

    const result = await service.prepareExecutionContext({
      taskId: task.id,
      contextTaskId: task.id,
      sessionId: 'sess_1',
      userPrompt: '继续整理 Phoenix 周报',
      executionMode: 'fresh',
    });

    expect(result.preferences.map(item => item.id)).toContain(pref.id);
    expect(result.conversationHistory.map(turn => turn.userInput)).toContain('先整理经营数据');
    const bundle: ExecutionContextBundleV2 = result.executionContextBundle;
    expect(result.executionContextBundle.taskBrief.id).toBe(task.id);
    expect(bundle.memoryContext.resolvedPreferences.map(item => item.id)).toContain(pref.id);
  });

  it('uses authoritative approved recall selection instead of broad preference recall', async () => {
    const task = taskEngine.create({ title: '报告', goal: '写报告' });
    const pref = memoryEngine.addManual({
      content: '凡是报告都要非常正式',
      scope: 'global',
      type: 'style',
    });

    const result = await service.prepareExecutionContext({
      taskId: task.id,
      contextTaskId: task.id,
      sessionId: 'sess_1',
      userPrompt: '写报告',
      executionMode: 'fresh',
      approvedRecallSelection: {
        authoritative: true,
        resolvedPreferences: [{
          id: pref.id,
          content: pref.content,
          scope: pref.scope,
          confidence: 0.9,
          reason: 'approved',
        }],
        relatedTaskIds: [],
        acceptedMemoryResources: [],
      },
    });

    expect(result.preferences.map(item => item.id)).toEqual([pref.id]);
    expect(result.resolvedPreferences.map(item => item.reason)).toEqual(['approved']);
  });

  it('normalizes inline resources through the memory context boundary', () => {
    const result = service.normalizeInlineResources(
      '基于 /tmp/a.md 整理报告',
      ['/tmp/a.md'],
      text => text.replace('/tmp/a.md', '').replace(/\s+/g, ' ').trim(),
    );

    expect(result.resources).toEqual(['/tmp/a.md']);
    expect(result.normalizedGoal).toBe('基于 整理报告');
  });

  it('parses and strips inline resources from input through the service', () => {
    const cwd = resolve(tmpdir(), 'metaclaw-memory-context-inline');
    mkdirSync(cwd, { recursive: true });
    const materialPath = resolve(cwd, 'material.md');
    writeFileSync(materialPath, 'material', 'utf-8');

    const result = service.normalizeInlineResourcesFromInput('基于 material.md 整理报告', cwd);

    expect(result.resources).toEqual([materialPath]);
    expect(result.normalizedGoal).toBe('整理报告');
  });
});
