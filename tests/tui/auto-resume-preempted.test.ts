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
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
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

async function waitForExecutorCallCount(execute: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (execute.mock.calls.length >= count) {
      return;
    }
    await flushUpdates();
  }
  throw new Error(`expected executor call count >= ${count}, got ${execute.mock.calls.length}`);
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

describe('App auto-resume after preemption', () => {
  it('resumes the preempted parked task before a later normal queued task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const firstDeferred = createDeferredResult();
    const urgentDeferred = createDeferredResult();
    const resumedDeferred = createDeferredResult();
    const laterNormalDeferred = createDeferredResult();

    let firstExecuteResolved = false;
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn()
        .mockImplementationOnce(() => firstDeferred.promise)
        .mockImplementationOnce(() => urgentDeferred.promise)
        .mockImplementationOnce(() => resumedDeferred.promise)
        .mockImplementationOnce(() => laterNormalDeferred.promise),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn().mockImplementation(() => {
        if (!firstExecuteResolved) {
          firstExecuteResolved = true;
          firstDeferred.resolve({
            success: false,
            output: '',
            error: 'execution interrupted',
            exitCode: 1,
            durationMs: 200,
            interrupted: true,
          });
        }
      }),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({
        route: 'durable_task',
        reason: '明确工作任务',
      }),
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
        sessionId: 'sess_auto_resume',
        contextRecaller,
        llmBridge,
        availableExecutorCommands: new Set(['codex']),
      })
    );

    const typeAndSubmit = async (text: string) => {
      for (const char of text) {
        await inputCapture.handler?.(char, {});
        await flushUpdates();
      }
      await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
      await flushUpdates();
    };

    await typeAndSubmit('主线研究任务');
    await typeAndSubmit('紧急优先处理这个任务');
    await typeAndSubmit('普通排队任务');

    expect(app.lastFrame()).toContain('任务队列前五');
    expect(app.lastFrame()).toContain('[执行中]');
    expect(app.lastFrame()).toContain('[待执行]');
    expect(app.lastFrame()).toContain('优先级');
    expect(app.lastFrame()).toContain('第 1 顺位');

    urgentDeferred.resolve({
      success: true,
      output: 'urgent done',
      exitCode: 0,
      durationMs: 400,
    });
    await waitForExecutorCallCount(executor.execute as ReturnType<typeof vi.fn>, 3);

    expect((executor.execute as ReturnType<typeof vi.fn>).mock.calls[2][0].task.title).toContain('主线研究任务');
    expect((executor.execute as ReturnType<typeof vi.fn>).mock.calls[2][0].executionContextBundle.mode).toBe('resume-parked');
    expect(taskEngine['taskRepo'].findByStatus('running')[0]?.title).toContain('主线研究任务');

    resumedDeferred.resolve({
      success: true,
      output: 'resumed done',
      exitCode: 0,
      durationMs: 500,
    });
    await waitForExecutorCallCount(executor.execute as ReturnType<typeof vi.fn>, 4);

    expect((executor.execute as ReturnType<typeof vi.fn>).mock.calls[3][0].task.title).toContain('普通排队任务');

    laterNormalDeferred.resolve({
      success: true,
      output: 'later done',
      exitCode: 0,
      durationMs: 300,
    });
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });
});
