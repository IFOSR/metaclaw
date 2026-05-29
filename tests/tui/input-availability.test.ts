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

describe('App input availability', () => {
  it('recalls submitted input history with up and down arrows', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-history');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'done',
        exitCode: 0,
        durationMs: 100,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({
        route: 'conversation',
        reason: 'history navigation test',
        response: 'ok',
      }),
      resolveIntent: vi.fn().mockResolvedValue({
        type: 'new',
        taskId: null,
        reason: '新任务',
      }),
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_input_history',
        contextRecaller,
        llmBridge,
      })
    );

    const typeText = async (text: string) => {
      for (const char of text) {
        await inputCapture.handler?.(char, {});
        await flushUpdates();
      }
    };
    const submit = async () => {
      await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
      await flushUpdates();
    };

    await typeText('第一条任务');
    await submit();
    await typeText('第二条任务');
    await submit();
    await typeText('当前草稿');

    await inputCapture.handler?.('', { upArrow: true });
    await flushUpdates();
    expect(app.lastFrame()).toContain('> 第二条任务');

    await inputCapture.handler?.('', { upArrow: true });
    await flushUpdates();
    expect(app.lastFrame()).toContain('> 第一条任务');

    await inputCapture.handler?.('', { downArrow: true });
    await flushUpdates();
    expect(app.lastFrame()).toContain('> 第二条任务');

    await inputCapture.handler?.('', { downArrow: true });
    await flushUpdates();
    expect(app.lastFrame()).toContain('> 当前草稿');

    app.unmount();
    app.cleanup();
  });

  it('uses arrow keys to choose slash command suggestions before falling back to history recall', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-command-suggestions');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'done',
        exitCode: 0,
        durationMs: 100,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({
        route: 'conversation',
        reason: 'command suggestion test',
        response: 'ok',
      }),
      resolveIntent: vi.fn().mockResolvedValue({
        type: 'new',
        taskId: null,
        reason: '新任务',
      }),
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_command_suggestions',
        contextRecaller,
        llmBridge,
      })
    );

    await inputCapture.handler?.('/', {});
    await flushUpdates();
    expect(app.lastFrame()).toContain('命令建议 ↑/↓ 选择，Enter 录入');
    expect(app.lastFrame()).toContain('/task');

    await inputCapture.handler?.('t', {});
    await inputCapture.handler?.('a', {});
    await flushUpdates();
    expect(app.lastFrame()).toContain('/task');
    expect(app.lastFrame()).toContain('/tasks');
    expect(app.lastFrame()).not.toContain('/memory');

    await inputCapture.handler?.('', { downArrow: true });
    await flushUpdates();
    await inputCapture.handler?.('', { return: true });
    await flushUpdates();
    expect(app.lastFrame()).toContain('> /tasks ');

    app.unmount();
    app.cleanup();
  });

  it('keeps the prompt usable and queues a new task while another task is running', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const firstDeferred = createDeferredResult();
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementationOnce(() => firstDeferred.promise),
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

    await type('主');
    await type('线');
    await type('任');
    await type('务');
    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();

    await type('排');
    await type('队');
    await type('任');
    await type('务');

    expect(app.lastFrame()).toContain('> 排队任务');
    expect(app.lastFrame()).toContain('status: running codex-cli');

    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();

    expect(app.lastFrame()).toContain('已进入待执行队列');

    firstDeferred.resolve({
      success: true,
      output: 'first done',
      exitCode: 0,
      durationMs: 1000,
    });
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });

  it('shows which running task was preempted and why when an urgent task arrives', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const firstDeferred = createDeferredResult();
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementationOnce(() => firstDeferred.promise).mockResolvedValue({
        success: true,
        output: 'urgent done',
        exitCode: 0,
        durationMs: 600,
      }),
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

    const typeAndSubmit = async (text: string) => {
      for (const char of text) {
        await inputCapture.handler?.(char, {});
        await flushUpdates();
      }
      await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
      await flushUpdates();
    };

    await typeAndSubmit('普通任务');
    const runningTaskId = taskEngine['taskRepo'].findByStatus('running')[0]?.id;

    await typeAndSubmit('紧急优先处理这个任务');

    expect(app.lastFrame()).toContain(`抢占当前任务 #${runningTaskId}`);
    expect(app.lastFrame()).toContain('原因：用户显式要求优先处理');

    firstDeferred.resolve({
      success: true,
      output: 'first done',
      exitCode: 0,
      durationMs: 800,
    });
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });

  it('falls back quickly when llm routing is stalled while another task is already running', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const firstDeferred = createDeferredResult();
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementationOnce(() => firstDeferred.promise),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const never = () => new Promise<never>(() => {});
    const llmBridge = {
      resolveRoute: vi.fn()
        .mockResolvedValueOnce({ route: 'durable_task', reason: '首个任务' })
        .mockImplementationOnce(never),
      resolveIntent: vi.fn()
        .mockResolvedValueOnce({ type: 'new', taskId: null, reason: '首个任务' })
        .mockImplementationOnce(never),
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_llm_stalled_while_running',
        contextRecaller,
        llmBridge,
      })
    );

    const typeAndSubmit = async (text: string) => {
      for (const char of text) {
        await inputCapture.handler?.(char, {});
        await flushUpdates();
      }
      return inputCapture.handler?.('', { return: true }) ?? Promise.resolve();
    };

    await typeAndSubmit('主线任务');
    await flushUpdates();

    const secondSubmit = typeAndSubmit('排队任务');
    await new Promise(resolve => setTimeout(resolve, 600));
    await flushUpdates();

    expect(app.lastFrame()).toContain('已进入待执行队列');
    expect(taskEngine['taskRepo'].findByStatus('ready')).toHaveLength(1);

    void secondSubmit;
    firstDeferred.resolve({
      success: true,
      output: 'first done',
      exitCode: 0,
      durationMs: 1000,
    });
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });

  it('shows the routed executor in the composer status while a task is running', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-routed-executor-status');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const piDeferred = createDeferredResult();
    const defaultExecutor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'default should not run',
        exitCode: 0,
        durationMs: 100,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const piExecutor: ExecutorAdapter = {
      name: 'pi-agent',
      execute: vi.fn().mockImplementation(() => piDeferred.promise),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: 'research automation' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: 'new task' }),
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor: defaultExecutor,
        db,
        config: createConfig(),
        sessionId: 'sess_routed_executor_status',
        contextRecaller,
        llmBridge,
        executorFactory: (name: string) => name === 'pi-agent' ? piExecutor : null,
        availableExecutorCommands: new Set(['codex', 'pi']),
      })
    );

    for (const char of '请调研这个方案并进行自动化分析，输出报告') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();
    await flushUpdates();

    expect(app.lastFrame()).toContain('status: running pi-agent');
    expect(app.lastFrame()).not.toContain('status: running codex-cli');
    expect(defaultExecutor.execute).not.toHaveBeenCalled();
    expect(piExecutor.execute).toHaveBeenCalledTimes(1);

    piDeferred.resolve({
      success: true,
      output: 'Pi Agent done',
      exitCode: 0,
      durationMs: 100,
    });
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });
});
