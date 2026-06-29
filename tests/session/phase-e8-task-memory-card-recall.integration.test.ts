import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskMemoryCardRepo } from '../../src/storage/task-memory-card-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/core/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { LlmBridge } from '../../src/core/llm-bridge.js';

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

function createDurableRouteBridge(): LlmBridge {
  return {
    resolveRoute: vi.fn().mockResolvedValue({
      route: 'durable_task',
      reason: 'phase e8 task memory card recall',
    }),
    resolveIntent: vi.fn().mockResolvedValue({
      type: 'new',
      taskId: null,
      reason: 'new task',
    }),
    rankInteractions: vi.fn().mockResolvedValue([]),
  } as unknown as LlmBridge;
}

describe('Phase E8 TaskMemoryCard recall integration', () => {
  it('skips uncertain task memory cards instead of asking for recall confirmation', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const contextRecaller = new ContextRecaller(db);
    const cardRepo = new TaskMemoryCardRepo(db);
    const memoryEngine = new MemoryEngine(
      new PreferenceRepo(db),
      new ObservationRepo(db),
      undefined,
      undefined,
      cardRepo,
    );
    const orchestration = new OrchestrationEngine(taskEngine);

    cardRepo.insert({
      id: 'tmc_phoenix_weekly_reference',
      taskId: 'task_phoenix_weekly_done',
      title: 'Phoenix 周报整理',
      goal: '整理 Phoenix 周报并补齐经营数据栏目',
      summary: '上次周报已验证风险栏目和经营数据栏目结构，可作为本次周报参考。',
      keyDecisions: ['周报必须保留风险栏目和经营数据栏目'],
      changedFiles: ['docs/phoenix-weekly.md'],
      verificationCommands: ['npm test -- tests/phoenix-weekly.test.ts'],
      pitfalls: ['不要复用过期销售漏斗数据'],
      artifacts: ['docs/phoenix-weekly-output.md'],
      outcome: 'success',
      sourceCandidateId: 'lc_phoenix_weekly_reference',
      createdAt: '2026-04-20T00:00:00Z',
      updatedAt: '2026-04-20T00:00:00Z',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'Phoenix 周报已完成',
        exitCode: 0,
        durationMs: 120,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_phase_e8_task_memory_card_review',
      contextRecaller,
      llmBridge: createDurableRouteBridge(),
    });

    session.initialize();
    await session.submit('整理 Phoenix 本周周报，补齐经营数据栏目', { awaitAsyncWork: true });

    const output = session.getSnapshot().output.join('\n');
    expect(output).not.toContain('记忆召回确认');
    expect(output).toContain('已跳过不确定记忆');
    expect(output).toContain('跳过：0 条偏好，1 条任务记忆');

    expect(executor.execute).toHaveBeenCalledTimes(1);
    const executionInput = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(executionInput.executionContextBundle.materialContext.resources).not.toContain('docs/phoenix-weekly-output.md');
  });
});
