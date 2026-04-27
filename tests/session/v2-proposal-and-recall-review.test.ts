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
import { RecallFeedbackRepo } from '../../src/storage/recall-feedback-repo.js';

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
  it('requires proposal confirmation and recall review before execution', async () => {
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
      resolveRoute: vi.fn(),
      resolveIntent: vi.fn(),
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
    expect(session.getSnapshot().output.join('\n')).toContain('操作提案');
    expect(executor.execute).not.toHaveBeenCalled();

    await session.submit('y');
    const afterProposalAccept = session.getSnapshot().output.join('\n');
    expect(afterProposalAccept).toContain('记忆召回确认');
    expect(afterProposalAccept).toContain('Phoenix 周报统一保留风险栏目和经营数据栏目');
    expect(executor.execute).not.toHaveBeenCalled();

    await session.submit('y', { awaitAsyncWork: true });
    const finalOutput = session.getSnapshot().output.join('\n');
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(finalOutput).toContain('Phoenix 周报已补齐经营数据并完成输出');
  });

  it('persists recall review feedback commands without executing until an adoption decision', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-feedback');
    const memoryEngine = new MemoryEngine(prefRepo, obsRepo);
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    prefRepo.insert({
      id: 'pref_project_feedback',
      type: 'domain',
      scope: 'project',
      subject: 'Phoenix',
      content: 'Phoenix 周报保留旧版销售漏斗栏目',
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
      goal: '继续整理 Phoenix 周报并改用新版经营数据栏目',
    });
    taskRepo.update(parkedTask.id, {
      status: 'parked',
      summary: '待切换新版栏目',
      snapshots: [{
        done: ['已完成旧版栏目草稿'],
        pending: ['切换新版栏目'],
        nextStep: '改用新版经营数据栏目',
        pauseReason: '等待确认',
        createdAt: '2026-04-20T00:00:00Z',
      }],
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '已按用户选择继续执行',
        exitCode: 0,
        durationMs: 100,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn(),
      resolveIntent: vi.fn(),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_v2_recall_feedback',
      contextRecaller,
      llmBridge,
    });

    session.initialize();
    await session.submit('y');
    expect(session.getSnapshot().output.join('\n')).toContain('记忆召回确认');

    await session.submit('i 1');
    await session.submit('m');
    expect(executor.execute).not.toHaveBeenCalled();

    const feedbackRepo = new RecallFeedbackRepo(db);
    const records = feedbackRepo.findActiveForCandidates({
      targetKind: 'preference',
      targetIds: ['pref_project_feedback'],
      queryTaskId: parkedTask.id,
    });
    expect(records.map(record => record.action)).toContain('irrelevant');

    const moreRecords = feedbackRepo.findActiveForCandidates({
      targetKind: 'task',
      targetIds: [parkedTask.id],
      queryTaskId: parkedTask.id,
    });
    expect(moreRecords.map(record => record.action)).toContain('more');

    await session.submit('x1', { awaitAsyncWork: true });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(feedbackRepo.findActiveForCandidates({
      targetKind: 'preference',
      targetIds: ['pref_project_feedback'],
      queryTaskId: parkedTask.id,
    }).map(record => record.action)).toContain('select');
  });
});
