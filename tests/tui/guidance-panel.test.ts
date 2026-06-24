import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { render } from 'ink-testing-library';
import { App } from '../../src/tui/app.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { MemoryEngine } from '../../src/core/memory-engine.js';
import { OrchestrationEngine } from '../../src/core/orchestration.js';
import { ContextRecaller } from '../../src/core/context-recaller.js';
import type { Config, ExecutorResult } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { LlmBridge } from '../../src/core/llm-bridge.js';

const inputCapture = vi.hoisted(() => ({
  handler: undefined as undefined | ((input: string, key: Record<string, boolean>) => Promise<void> | void),
}));

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  return {
    ...actual,
    useInput: (handler: (input: string, key: Record<string, boolean>) => Promise<void> | void) => {
      inputCapture.handler = handler;
    },
  };
});

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

function flushUpdates() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushUpdates();
    }
  }

  throw lastError;
}

function createDeferredResult() {
  let resolve!: (value: ExecutorResult) => void;
  const promise = new Promise<ExecutorResult>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

async function typeAndSubmit(text: string) {
  for (const char of text) {
    await inputCapture.handler?.(char, {});
    await flushUpdates();
  }

  await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
  await flushUpdates();
}

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App guidance panel', () => {
  it('renders the latest guidance in a dedicated panel instead of only in the transcript', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const startupTask = taskEngine.create({ title: '整理 Phoenix 周报', goal: '继续整理 Phoenix 周报' });
    taskRepo.update(startupTask.id, {
      prioritySignals: {
        dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        isReady: true,
        progressRatio: 0.5,
        blocksOthers: false,
        idleHours: 0,
      },
    });
    taskEngine.transition(startupTask.id, 'ready');

    const deferred = createDeferredResult();
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementationOnce(() => deferred.promise),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn(),
      resolveIntent: vi.fn(),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_guidance_panel',
        contextRecaller,
        llmBridge,
      }),
    );

    await waitFor(() => {
      expect(app.lastFrame()).toContain('当前建议');
      expect(app.lastFrame()).toContain('场景: 启动建议');
      expect(app.lastFrame()).toContain(startupTask.id);
      expect(app.lastFrame()).toContain(startupTask.title);
    });

    app.unmount();
    app.cleanup();
  });

  it('updates the guidance panel after task completion points to the next queued task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const firstDeferred = createDeferredResult();
    const secondDeferred = createDeferredResult();
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn()
        .mockImplementationOnce(() => firstDeferred.promise)
        .mockImplementationOnce(() => secondDeferred.promise),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: '测试 durable task' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: '新任务' }),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_guidance_panel_completion',
        contextRecaller,
        llmBridge,
      }),
    );

    await typeAndSubmit('先完成普通执行任务甲');
    await typeAndSubmit('再完成普通执行任务乙');

    firstDeferred.resolve({
      success: true,
      output: '第一项任务完成',
      exitCode: 0,
      durationMs: 500,
    });

    await waitFor(() => {
      const queuedTask = taskEngine.list().find(task => task.title.includes('再完成普通执行任务乙'));
      expect(queuedTask).toBeDefined();
      expect(app.lastFrame()).toContain('当前建议');
      expect(app.lastFrame()).toContain('场景: 完成后建议');
      expect(app.lastFrame()).toContain(queuedTask!.id);
      expect(app.lastFrame()).toContain(queuedTask!.title);
    });

    app.unmount();
    app.cleanup();
  });
});
