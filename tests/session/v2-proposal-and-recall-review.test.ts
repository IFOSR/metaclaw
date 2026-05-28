import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { MemoryEngine } from '../../src/core/memory-engine.js';
import { OrchestrationEngine } from '../../src/core/orchestration.js';
import { ContextRecaller } from '../../src/core/context-recaller.js';
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { LlmBridge } from '../../src/core/llm-bridge.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: {
      command: 'codex',
      timeout: 60_000,
    },
    orchestration: {
      reminder_enabled: true,
      reminder_throttle: 3600,
      top_k_preferences: 5,
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
  };
}

describe('V2 proposal flow', () => {
  it('shows proposals without confirmation and lets scheduler resume eligible work', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(prefRepo, obsRepo);
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    prefRepo.insert({
      id: 'pref_project',
      type: 'domain',
      scope: 'project',
      subject: 'Phoenix',
      content: 'Phoenix 周报统一保留风险栏目和经营数据栏目',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 3,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-04-20T00:00:00Z',
      createdAt: '2026-04-20T00:00:00Z',
      updatedAt: '2026-04-20T00:00:00Z',
    });

    const parkedTask = taskEngine.create({
      title: 'Phoenix 周报整理',
      goal: '继续整理 Phoenix 周报并补齐经营数据',
    });
    taskRepo.update(parkedTask.id, {
      status: 'parked',
      summary: '已整理风险栏目，待补经营数据',
      snapshots: [{
        done: ['已整理风险栏目'],
        pending: ['待补经营数据'],
        nextStep: '补齐经营数据并输出最终周报',
        pauseReason: '等待经营数据',
        createdAt: '2026-04-20T00:00:00Z',
      }],
      prioritySignals: {
        dueAt: null,
        isReady: true,
        progressRatio: 0.8,
        blocksOthers: false,
        idleHours: 3,
      },
      lastInterruptionReason: '等待经营数据',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'Phoenix 周报已补齐经营数据并完成输出',
        exitCode: 0,
        durationMs: 200,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: '新任务' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: '新任务' }),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_v2_proposal_review',
      contextRecaller,
      llmBridge,
    });

    session.initialize();
    await session.waitForAsyncWork();
    expect(session.getSnapshot().output.join('\n')).toContain('操作提案');
    const afterProposalAccept = session.getSnapshot().output.join('\n');
    expect(afterProposalAccept).not.toContain('记忆召回确认');
    expect(afterProposalAccept).not.toContain('请输入 [y]');
    expect(afterProposalAccept).toContain('→ 已注入 1 条偏好');
    expect(afterProposalAccept).toContain('Phoenix 周报统一保留风险栏目和经营数据栏目');
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(afterProposalAccept).toContain('Phoenix 周报已补齐经营数据并完成输出');
  });

  it('auto-applies high-confidence recall candidates and skips uncertain candidates without confirmation', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-tristate');
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    prefRepo.insert({
      id: 'pref_auto_apply',
      type: 'style',
      scope: 'project',
      subject: 'MetaClaw',
      content: 'MetaClaw 优化方案默认先给结论，再列执行细节',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 1,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-05-20T00:00:00Z',
      createdAt: '2026-05-20T00:00:00Z',
      updatedAt: '2026-05-20T00:00:00Z',
    });
    prefRepo.insert({
      id: 'pref_ask_review',
      type: 'domain',
      scope: 'global',
      subject: null,
      content: '长篇报告需要同步生成飞书云文档',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 1,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-05-20T00:00:00Z',
      createdAt: '2026-05-20T00:00:00Z',
      updatedAt: '2026-05-20T00:00:00Z',
    });

    const memoryEngine = new MemoryEngine(
      prefRepo,
      obsRepo,
      undefined,
      undefined,
      undefined,
      {
        recallPreferences: vi.fn().mockResolvedValue([
          {
            preferenceId: 'pref_auto_apply',
            action: 'auto_apply',
            reason: '当前任务明确是 MetaClaw 优化方案，低风险输出结构偏好适用',
            score: 0.92,
          },
          {
            preferenceId: 'pref_ask_review',
            action: 'ask_review',
            reason: '可能触发外部文档同步，需要确认',
            score: 0.7,
          },
        ]),
      },
    );

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'MetaClaw 优化已完成',
        exitCode: 0,
        durationMs: 100,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: '新任务' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: '新任务' }),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_v2_tristate',
      contextRecaller,
      llmBridge,
    });

    session.initialize();
    await session.submit('根据最终优化方案实施 MetaClaw', { awaitAsyncWork: true });

    const output = session.getSnapshot().output.join('\n');
    expect(output).not.toContain('记忆召回确认');
    expect(output).toContain('已自动采用记忆');
    expect(output).toContain('pref_auto_apply');
    expect(output).toContain('已跳过不确定记忆');
    expect(output).toContain('跳过：1 条偏好，0 条任务记忆');
    const suppressAudit = db.prepare(
      `SELECT action, memory_id, reason, judge_source FROM memory_audit_events
       WHERE memory_id = ? AND action = 'suppress'
       ORDER BY created_at DESC LIMIT 1`
    ).get('pref_ask_review') as { action: string; memory_id: string; reason: string; judge_source: string } | undefined;
    expect(suppressAudit).toEqual(expect.objectContaining({
      action: 'suppress',
      memory_id: 'pref_ask_review',
      reason: expect.stringContaining('不确定是否适用，默认不召回'),
      judge_source: 'llm',
    }));

    const executionInput = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const resolvedPreferences = executionInput.executionContextBundle.memoryContext.resolvedPreferences;
    expect(resolvedPreferences.map((preference: { id: string }) => preference.id)).toEqual([
      'pref_auto_apply',
    ]);

    const finalOutput = session.getSnapshot().output.join('\n');
    expect(finalOutput).toContain('已自动采用记忆');
    expect(finalOutput).toContain('pref_auto_apply');

    const task = taskRepo.findAll().find(item => item.goal === '根据最终优化方案实施 MetaClaw');
    expect(task).toBeTruthy();
    await session.submit(`/memory applied ${task!.id}`);
    const auditOutput = session.getSnapshot().output.join('\n');
    expect(auditOutput).toContain('已自动采用记忆');
    expect(auditOutput).toContain('pref_auto_apply');
    expect(auditOutput).toContain('score=0.92');
  });

  it('does not ask for recall confirmation for Feishu-style submissions either', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-feishu-recall');
    const memoryEngine = new MemoryEngine(prefRepo, obsRepo);
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    prefRepo.insert({
      id: 'pref_feishu_recall',
      type: 'domain',
      scope: 'global',
      subject: null,
      content: '调研报告需要同步生成飞书云文档和在线预览',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 2,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-05-20T00:00:00Z',
      createdAt: '2026-05-20T00:00:00Z',
      updatedAt: '2026-05-20T00:00:00Z',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '飞书调研报告已生成',
        exitCode: 0,
        durationMs: 100,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: '飞书任务' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: '新任务' }),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_feishu_auto_recall',
      contextRecaller,
      llmBridge,
      executorFactory: () => executor,
    });

    session.initialize();
    await session.submit('做一个深度调研报告服务，需要飞书云文档和在线预览', {
      awaitAsyncWork: true,
    });

    const output = session.getSnapshot().output.join('\n');
    expect(output).not.toContain('记忆召回确认');
    expect(output).not.toContain('请输入 [y]');
    expect(output).toContain('已跳过不确定记忆');
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});
