import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
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

function createDurableRouteBridge(): LlmBridge {
  return {
    resolveRoute: vi.fn().mockResolvedValue({
      route: 'durable_task',
      reason: '明确任务',
    }),
    resolveIntent: vi.fn().mockResolvedValue({
      type: 'new',
      taskId: null,
      reason: '新任务',
    }),
    rankInteractions: vi.fn().mockResolvedValue([]),
  } as unknown as LlmBridge;
}

describe('global style scene gating', () => {
  it('does not interrupt PPT structuring tasks with incompatible personality-style recall review', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    memoryEngine.addManual({
      content: '用活泼的语气',
      scope: 'global',
      type: 'style',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'PPT 大纲已整理完成',
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
      sessionId: 'sess_round13_global_style_scene',
      contextRecaller,
      llmBridge: createDurableRouteBridge(),
    });

    session.initialize();
    await session.submit('直接把刚才我们讨论的内容整理成ppt', { awaitAsyncWork: true });

    const output = session.getSnapshot().output.join('\n');
    expect(output).not.toContain('记忆召回确认');
    expect(output).not.toContain('用活泼的语气');
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('auto-applies applicable formal tone without recall confirmation', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    memoryEngine.addManual({
      content: '用活泼欢快的语气',
      scope: 'global',
      type: 'style',
    });
    memoryEngine.addManual({
      content: '使用正式严谨的表达',
      scope: 'global',
      type: 'style',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '调研报告已完成',
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
      sessionId: 'sess_round13_formal_research_style_gate',
      contextRecaller,
      llmBridge: createDurableRouteBridge(),
      executorFactory: () => executor,
    });

    session.initialize();
    await session.submit('帮我写一份正式的行业调研报告', { awaitAsyncWork: true });

    const output = session.getSnapshot().output.join('\n');
    expect(output).not.toContain('记忆召回确认');
    expect(output).toContain('已自动采用记忆');
    expect(output).toContain('使用正式严谨的表达');
    expect(output).not.toContain('用活泼欢快的语气');
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});
