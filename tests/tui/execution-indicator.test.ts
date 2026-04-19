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

function createDeferredResult() {
  let resolve!: (value: ExecutorResult) => void;
  const promise = new Promise<ExecutorResult>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App execution indicator', () => {
  it('does not render the completion frame with a lingering running count', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const deferred = createDeferredResult();
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockReturnValue(deferred.promise),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveIntent: vi.fn().mockResolvedValue({
        type: 'new',
        taskId: null,
        reason: '新任务',
      }),
    } as unknown as LlmBridge;

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_test',
        contextRecaller,
        llmBridge,
      })
    );

    const type = async (char: string) => {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    };

    await type('调');
    await type('研');
    await type('任');
    await type('务');

    const submitPromise = inputCapture.handler?.('', { return: true }) ?? Promise.resolve();
    await flushUpdates();

    expect(app.frames.some(frame => frame.includes('当前执行 1 | 待执行 0 | 已挂起 0 | 阻塞 0'))).toBe(true);

    deferred.resolve({
      success: true,
      output: '执行完成',
      exitCode: 0,
      durationMs: 1200,
    });

    await submitPromise;
    await flushUpdates();

    expect(
      app.frames.some(frame => frame.includes('✓ 任务完成') && frame.includes('当前执行 1 |'))
    ).toBe(false);
    expect(app.lastFrame()).toContain('✓ 任务完成');
    expect(app.lastFrame()).toContain('当前执行 0 | 待执行 0 | 已挂起 0 | 阻塞 0');
    expect(app.lastFrame()).toContain('status: idle');

    app.unmount();
    app.cleanup();
  });

  it('shows parked task count in the runtime summary', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const parkedTask = taskEngine.create({ title: '待恢复任务', goal: '继续调研' });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '被高优任务抢占', {
      done: ['已完成一半'],
      pending: ['继续剩余部分'],
      nextStep: '继续调研剩余部分',
      pauseReason: '被高优任务抢占',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveIntent: vi.fn(),
    } as unknown as LlmBridge;

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_parked_summary',
        contextRecaller,
        llmBridge,
      })
    );

    await flushUpdates();

    expect(app.lastFrame()).toContain('当前执行 0 | 待执行 0 | 已挂起 1 | 阻塞 0');
    expect(app.lastFrame()).toContain('最近事件 0');

    app.unmount();
    app.cleanup();
  });

  it('shows the last scheduler event in the runtime summary', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const deferred = createDeferredResult();
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockReturnValue(deferred.promise),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveIntent: vi.fn().mockResolvedValue({
        type: 'new',
        taskId: null,
        reason: '新任务',
      }),
    } as unknown as LlmBridge;

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_last_event',
        contextRecaller,
        llmBridge,
      })
    );

    await inputCapture.handler?.('调', {});
    await flushUpdates();
    await inputCapture.handler?.('研', {});
    await flushUpdates();
    await inputCapture.handler?.('任', {});
    await flushUpdates();
    await inputCapture.handler?.('务', {});
    await flushUpdates();
    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();

    expect(app.lastFrame()).toContain('最近事件 开始执行任务 #');

    app.unmount();
    app.cleanup();
  });
});
