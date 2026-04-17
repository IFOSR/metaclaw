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

describe('App resume-running task noop', () => {
  it('does not queue a duplicate request when the referenced parked task is already running again', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const runningDeferred = createDeferredResult();
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementationOnce(() => runningDeferred.promise),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };

    const llmBridge = {
      resolveIntent: vi.fn().mockImplementation(async (userInput: string) => {
        if (userInput.includes('把之前挂起的任务继续完成')) {
          return {
            type: 'reference',
            taskId: taskRepo.findByStatus('running')[0]?.id ?? null,
            reason: '用户是在继续之前挂起、现已恢复中的任务',
          };
        }

        return {
          type: 'new',
          taskId: null,
          reason: '创建任务',
        };
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
        sessionId: 'sess_resume_running_noop',
        contextRecaller,
        llmBridge,
      }),
    );

    const typeAndSubmit = async (text: string) => {
      for (const char of text) {
        await inputCapture.handler?.(char, {});
        await flushUpdates();
      }
      await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
      await flushUpdates();
    };

    await typeAndSubmit('给agent增加memory是一个非常重要，切目前有不少开源项目都在foucs的方向。你充分调研这个');
    const createdTask = taskRepo.findByStatus('running')[0];
    expect(createdTask).toBeTruthy();
    const taskId = createdTask!.id;

    await typeAndSubmit('把之前挂起的任务继续完成');

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(taskRepo.findByStatus('ready')).toHaveLength(0);
    expect(taskRepo.findAll()).toHaveLength(1);
    expect(app.lastFrame()).toContain(`任务 #${taskId} 已在执行中，无需再次排队`);

    runningDeferred.resolve({
      success: true,
      output: 'memory research done',
      exitCode: 0,
      durationMs: 500,
    });
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });
});
