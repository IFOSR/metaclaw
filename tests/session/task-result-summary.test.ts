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
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { LlmBridge } from '../../src/core/llm-bridge.js';

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
      dashboard_on_start: false,
    },
  };
}

function createSession(): MetaclawSession {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-summary-tests');
  const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
  const orchestration = new OrchestrationEngine(taskEngine);
  const executor: ExecutorAdapter = {
    name: 'codex-cli',
    execute: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    abort: vi.fn(),
  };
  const llmBridge = {
    resolveRoute: vi.fn(),
    resolveIntent: vi.fn(),
    resolveTaskPriority: vi.fn(),
    rankInteractions: vi.fn(),
  } as unknown as LlmBridge;

  return new MetaclawSession({
    taskEngine,
    memoryEngine,
    orchestration,
    executor,
    db,
    config: createConfig(),
    sessionId: 'sess_summary_test',
    contextRecaller: new ContextRecaller(db),
    llmBridge,
    executorFactory: () => executor,
  });
}

describe('MetaclawSession task result summary', () => {
  it('does not use an empty quoted file path as the task summary', () => {
    const session = createSession() as any;
    const summary = session.buildTaskResultSummary(
      '已创建文件：``\n保存路径：/tmp/metaclaw-output/smoke-result.md',
      ['/tmp/metaclaw-output/smoke-result.md'],
      {
        allowFilesystem: true,
        targetPaths: ['/tmp/metaclaw-output'],
      },
    );

    expect(summary).not.toBe('已创建文件：``');
    expect(summary).toContain('/tmp/metaclaw-output/smoke-result.md');
  });
});
