import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { MemoryEngine } from '../../src/core/memory-engine.js';
import { ContextRecaller } from '../../src/core/context-recaller.js';
import { ResumeContextBuilder } from '../../src/core/resume-context-builder.js';
import type { Preference } from '../../src/core/types.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('ResumeContextBuilder', () => {
  let db: Database.Database;
  let taskRepo: TaskRepo;
  let prefRepo: PreferenceRepo;
  let taskEngine: TaskEngine;
  let memoryEngine: MemoryEngine;
  let contextRecaller: ContextRecaller;
  let builder: ResumeContextBuilder;

  beforeEach(() => {
    db = createTestDb();
    taskRepo = new TaskRepo(db);
    prefRepo = new PreferenceRepo(db);
    taskEngine = new TaskEngine(taskRepo, resolve(tmpdir(), 'metaclaw-test-snapshots'));
    memoryEngine = new MemoryEngine(prefRepo, new ObservationRepo(db));
    contextRecaller = new ContextRecaller(db);
    builder = new ResumeContextBuilder(taskEngine, memoryEngine, contextRecaller);
  });

  function insertInteraction(input: {
    id: string;
    taskId: string;
    sessionId: string;
    userInput: string;
    systemOutput: string;
    createdAt: string;
  }) {
    db.prepare(
      'INSERT INTO interactions (id, task_id, session_id, user_input, system_output, executor_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(input.id, input.taskId, input.sessionId, input.userInput, input.systemOutput, 'codex-cli', input.createdAt);
  }

  function insertPreference(pref: Preference) {
    prefRepo.insert(pref);
  }

  it('builds a parked resume bundle with last progress and interruption reason', async () => {
    const task = taskEngine.create({ title: '行业分析', goal: '完成分析摘要', resources: ['/tmp/report-a.md'] });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.park(task.id, '被高优任务抢占', {
      done: ['报告 A 已完成'],
      pending: ['报告 B 待分析'],
      nextStep: '继续分析报告 B',
      pauseReason: '被高优任务抢占',
    });
    taskRepo.update(task.id, { lastInterruptionReason: '被任务 #task_high 抢占' });

    insertInteraction({
      id: 'int_1',
      taskId: task.id,
      sessionId: 'sess_1',
      userInput: '先分析报告 A',
      systemOutput: '报告 A 分析已完成',
      createdAt: '2026-04-16T00:00:00Z',
    });

    const bundle = await builder.build({
      taskId: task.id,
      mode: 'resume-parked',
      userInput: '继续刚才的分析',
      sessionId: 'sess_1',
      schedulingReason: '高优任务已完成，恢复主线',
    });

    expect(bundle.mode).toBe('resume-parked');
    expect(bundle.resumeContext?.lastProgress).toContain('报告 A 已完成');
    expect(bundle.resumeContext?.interruptionReason).toBe('被任务 #task_high 抢占');
    expect(bundle.resumeContext?.nextStep).toBe('继续分析报告 B');
    expect(bundle.historyContext.taskTurns).toHaveLength(1);
    expect(bundle.materialContext.resources).toContain('/tmp/report-a.md');
  });

  it('builds a blocked resume bundle with blocked reason and newly provided resources', async () => {
    const task = taskEngine.create({ title: '起诉书草稿', goal: '补齐起诉材料' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: '等待客户补充证据文件',
      status: 'waiting',
    });

    const bundle = await builder.build({
      taskId: task.id,
      mode: 'resume-blocked',
      userInput: '客户已经补了材料，继续',
      sessionId: 'sess_2',
      schedulingReason: '阻塞已解除',
      newlyProvidedResources: ['/tmp/evidence-v3.pdf'],
    });

    expect(bundle.mode).toBe('resume-blocked');
    expect(bundle.resumeContext?.blockedReason).toBe('等待客户补充证据文件');
    expect(bundle.materialContext.resources).toContain('/tmp/evidence-v3.pdf');
    expect(bundle.executionInstructions.some(line => line.includes('先检查新增材料是否足以推进任务'))).toBe(true);
  });

  it('orders memory context as current input, then task-local, then broader scopes', async () => {
    const task = taskEngine.create({ title: '周报整理', goal: '整理本周周报' });

    insertPreference({
      id: 'pref_task',
      type: 'style',
      scope: 'task-local',
      subject: null,
      content: '输出用表格格式',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 1,
      sourceTasks: [task.id],
      lastUsedAt: null,
      confirmedAt: '2026-04-16T00:00:00Z',
      createdAt: '2026-04-16T00:00:00Z',
      updatedAt: '2026-04-16T00:00:00Z',
    });
    insertPreference({
      id: 'pref_contact',
      type: 'contact',
      scope: 'contact',
      subject: '张总',
      content: '给张总的内容用正式语气并保持表格结构',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 1,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-04-16T00:00:00Z',
      createdAt: '2026-04-16T00:00:00Z',
      updatedAt: '2026-04-16T00:00:00Z',
    });
    insertPreference({
      id: 'pref_global',
      type: 'style',
      scope: 'global',
      subject: null,
      content: '输出尽量简洁并保留表格',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 1,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-04-16T00:00:00Z',
      createdAt: '2026-04-16T00:00:00Z',
      updatedAt: '2026-04-16T00:00:00Z',
    });

    const bundle = await builder.build({
      taskId: task.id,
      mode: 'fresh',
      userInput: '给张总整理一份周报，今天明确要求先保留表格格式',
      sessionId: 'sess_3',
    });

    expect(bundle.memoryContext.explicitUserInstruction).toContain('今天明确要求先保留表格格式');
    expect(bundle.memoryContext.resolvedPreferences.map(pref => pref.id)).toEqual([
      'pref_task',
      'pref_contact',
      'pref_global',
    ]);
  });

  it('prefers project memory over contact memory for project artifact tasks', async () => {
    const task = taskEngine.create({ title: 'Phoenix 项目术语表', goal: '整理 Phoenix 项目术语表给张总审阅' });

    insertPreference({
      id: 'pref_project',
      type: 'domain',
      scope: 'project',
      subject: 'Phoenix',
      content: 'Phoenix 项目材料统一使用 Phoenix 术语体系',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 1,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-04-16T00:00:00Z',
      createdAt: '2026-04-16T00:00:00Z',
      updatedAt: '2026-04-16T00:00:00Z',
    });
    insertPreference({
      id: 'pref_contact',
      type: 'contact',
      scope: 'contact',
      subject: '张总',
      content: '给张总的内容使用正式语气',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 1,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-04-16T00:00:00Z',
      createdAt: '2026-04-16T00:00:00Z',
      updatedAt: '2026-04-16T00:00:00Z',
    });

    const bundle = await builder.build({
      taskId: task.id,
      mode: 'fresh',
      userInput: '整理 Phoenix 项目术语表给张总审阅，术语必须统一',
      sessionId: 'sess_5',
    });

    expect(bundle.memoryContext.resolvedPreferences.map(pref => pref.id)).toEqual([
      'pref_project',
      'pref_contact',
    ]);
  });

  it('builds a task-scoped workspace write context for file-generation requests', async () => {
    const task = taskEngine.create({ title: '落地活动页', goal: '生成一个可交付的 HTML 文件' });

    const bundle = await builder.build({
      taskId: task.id,
      mode: 'fresh',
      userInput: '生成一个宣传活动页的 html 文件，包含标题和报名按钮',
      sessionId: 'sess_4',
    });

    expect(bundle.workspaceContext?.allowFilesystem).toBe(true);
    expect(bundle.workspaceContext?.targetPaths[0]).toBe(resolve(process.cwd(), 'metaclaw-tasks', task.id));
    expect(bundle.executionInstructions.some(line => line.includes('必须把结果写入本地文件系统'))).toBe(true);
    expect(bundle.executionInstructions.some(line => line.includes('不要在回复中粘贴或打印完整文件内容'))).toBe(true);
  });

  it('extracts readable text material excerpts into the execution bundle', async () => {
    const fixturesDir = resolve(tmpdir(), 'metaclaw-material-fixtures');
    mkdirSync(fixturesDir, { recursive: true });
    const weeklyPath = resolve(fixturesDir, 'phoenix-weekly.md');
    const risksPath = resolve(fixturesDir, 'risks.md');
    writeFileSync(weeklyPath, '# Phoenix Weekly\n本周完成核心模块联调，主线推进稳定。', 'utf-8');
    writeFileSync(risksPath, '# Risks\n跨团队依赖确认滞后，测试数据准备不足。', 'utf-8');

    const task = taskEngine.create({
      title: 'Phoenix 周报整理',
      goal: '整理 Phoenix 周报',
      resources: [weeklyPath, risksPath],
    });

    const bundle = await builder.build({
      taskId: task.id,
      mode: 'fresh',
      userInput: '结合材料整理 Phoenix 周报结论',
      sessionId: 'sess_6',
    });

    expect(bundle.materialContext.resources).toEqual([weeklyPath, risksPath]);
    expect(bundle.materialContext.textSnippets).toHaveLength(2);
    expect(bundle.materialContext.textSnippets[0]?.content).toContain('核心模块联调');
    expect(bundle.materialContext.textSnippets[1]?.content).toContain('测试数据准备不足');
  });
});
