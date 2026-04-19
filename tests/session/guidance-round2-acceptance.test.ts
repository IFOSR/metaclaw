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

function createConfig(overrides?: Partial<Config['orchestration']>): Config {
  return {
    version: 1,
    executor: {
      command: 'codex',
      timeout: 60_000,
    },
    orchestration: {
      reminder_enabled: true,
      reminder_throttle: 60,
      top_k_preferences: 5,
      ...overrides,
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
  };
}

function createSession(config: Config) {
  const db = createTestDb();
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
  const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
  const orchestration = new OrchestrationEngine(taskEngine);
  const contextRecaller = new ContextRecaller(db);
  const executor: ExecutorAdapter = {
    name: 'codex-cli',
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: 'ok',
      exitCode: 0,
      durationMs: 50,
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
    config,
    sessionId: 'sess_guidance_round2',
    contextRecaller,
    llmBridge,
  });

  return { session, taskEngine, taskRepo };
}

describe('Round 2 guidance acceptance', () => {
  it('emits a throttled idle reminder when there is an actionable blocked task', () => {
    const { session, taskEngine } = createSession(createConfig({
      reminder_enabled: true,
      reminder_throttle: 60,
    }));

    const task = taskEngine.create({ title: 'Phoenix 周报', goal: '整理 Phoenix 周报' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: '等待 Phoenix 周报附件',
      status: 'waiting',
    });

    session.initialize();
    session.maybeEmitIdleGuidance(1_000);
    const firstOutput = session.getSnapshot().output.join('\n');

    expect(firstOutput).toContain('💡 提醒');
    expect(firstOutput).toContain(task.id);
    expect(firstOutput).toContain('检查并解除阻塞');

    const outputSizeAfterFirstReminder = session.getSnapshot().output.length;
    session.maybeEmitIdleGuidance(10_000);
    expect(session.getSnapshot().output).toHaveLength(outputSizeAfterFirstReminder);

    session.maybeEmitIdleGuidance(62_000);
    const secondOutput = session.getSnapshot().output.join('\n');
    expect(secondOutput.match(/💡 提醒/g)?.length).toBe(2);
  });

  it('does not emit idle reminders when reminder_enabled is false', () => {
    const { session, taskEngine } = createSession(createConfig({
      reminder_enabled: false,
    }));

    const task = taskEngine.create({ title: 'Phoenix 任务', goal: '整理 Phoenix 材料' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: '等待 Phoenix 材料',
      status: 'waiting',
    });

    session.initialize();
    session.maybeEmitIdleGuidance(5_000);

    expect(session.getSnapshot().output.join('\n')).not.toContain('💡 提醒');
  });
});
