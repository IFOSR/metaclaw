import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { render } from 'ink-testing-library';
import { App } from '../../src/tui/app.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
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

function createDeferredResult() {
  let resolve!: (value: ExecutorResult) => void;
  const promise = new Promise<ExecutorResult>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function semanticDurableTask(reason: string) {
  return JSON.stringify({
    interactionType: 'durable_task',
    confidence: 0.9,
    shouldAskBeforeActing: false,
    ambiguity: [],
    risk: 'low',
    reason,
    clarificationQuestion: null,
    taskBinding: { type: 'new', taskId: null, reason },
    taskControl: null,
    executorDecision: {
      selectedExecutor: 'codex-cli',
      action: 'auto_dispatch',
      confidence: 0.9,
      primaryIntent: 'repo_execution',
      matchedBoundary: ['repo_execution'],
      reason,
      candidates: [{ executorName: 'codex-cli', score: 0.9, reason, matchedBoundary: ['repo_execution'] }],
      rejected: [],
    },
  });
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

  it('supports multiline terminal editing with spaces, cursor movement, backspace, and forward delete before submit', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-multiline-editor');
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
        reason: 'multiline editor test',
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
        sessionId: 'sess_multiline_editor',
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

    await typeText('第一行');
    await (inputCapture.handler?.('', { return: true, shift: true }) ?? Promise.resolve());
    await flushUpdates();

    expect(llmBridge.resolveRoute).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain('第一行');

    await typeText('第二  错行');
    await inputCapture.handler?.('', { leftArrow: true });
    await flushUpdates();
    await inputCapture.handler?.('', { leftArrow: true });
    await flushUpdates();
    await inputCapture.handler?.('\u001b[3~', {});
    await flushUpdates();
    await inputCapture.handler?.('', { delete: true });
    await flushUpdates();
    await typeText('补  充');

    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();

    expect(llmBridge.resolveRoute).toHaveBeenCalledWith(
      '第一行\n第二 补  充行',
      expect.any(Array),
    );
    expect(app.lastFrame()).toContain('> 第一行');
    expect(app.lastFrame()).toContain('第二 补  充行');

    app.unmount();
    app.cleanup();
  });

  it('treats the Ink delete key event as normal Backspace in the composer', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-normal-backspace');
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
        reason: 'backspace test',
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
        sessionId: 'sess_normal_backspace',
        contextRecaller,
        llmBridge,
      })
    );

    for (const char of 'abc') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    await inputCapture.handler?.('', { delete: true });
    await flushUpdates();
    await inputCapture.handler?.('', { delete: true });
    await flushUpdates();
    await inputCapture.handler?.('X', {});
    await flushUpdates();

    expect(app.lastFrame()).toContain('│ > aX');

    app.unmount();
    app.cleanup();
  });

  it('treats a raw LF terminal Enter as submit instead of inserting it into the editor', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-raw-lf-submit');
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
        reason: 'raw LF submit test',
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
        sessionId: 'sess_raw_lf_submit',
        contextRecaller,
        llmBridge,
      })
    );

    for (const char of '请生成报告') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    await inputCapture.handler?.('\n', {});
    await flushUpdates();

    expect(llmBridge.resolveRoute).toHaveBeenCalledWith('请生成报告', expect.any(Array));
    expect(app.lastFrame()).toContain('> 请生成报告');

    await inputCapture.handler?.('X', {});
    await flushUpdates();
    expect(app.lastFrame()).toContain('│ > X');

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

  it('keeps the prompt usable and rejects a new top-level task while another task is running', async () => {
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
        output: 'queued done',
        exitCode: 0,
        durationMs: 500,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      query: vi.fn()
        .mockResolvedValueOnce(semanticDurableTask('主线任务'))
        .mockResolvedValueOnce(semanticDurableTask('排队任务')),
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

    expect(app.lastFrame()).toContain('单活跃任务限制');
    expect(taskEngine['taskRepo'].findByStatus('ready')).toHaveLength(0);

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

  it('shows a processing composer status while submitted input is still being routed', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-processing-status');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const executorDeferred = createDeferredResult();
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(() => executorDeferred.promise),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    let resolveRoute!: (value: string) => void;
    const pendingRoute = new Promise<string>(resolve => {
      resolveRoute = resolve;
    });
    const llmBridge = {
      query: vi.fn().mockImplementation(() => pendingRoute),
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
        sessionId: 'sess_processing_status',
        contextRecaller,
        llmBridge,
      })
    );

    for (const char of '生成一个状态报告') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    const submitPromise = inputCapture.handler?.('', { return: true }) ?? Promise.resolve();
    await flushUpdates();

    expect(app.lastFrame()).toContain('status: processing');
    expect(app.lastFrame()).toContain('> 生成一个状态报告');
    expect(app.lastFrame()).toContain('【MetaClaw｜理解用户请求】');
    expect(app.lastFrame()).toContain('→ MetaClaw：正在分析目标、上下文与可执行边界');

    resolveRoute(semanticDurableTask('生成状态报告'));
    await flushUpdates();

    expect(app.lastFrame()).toContain('→ MetaClaw：已识别可执行任务');
    expect(app.lastFrame()).toContain('→ MetaClaw：执行策略：创建可追踪任务并派发给 codex-cli');
    expect(app.lastFrame()).toContain('【Executor: codex-cli｜派发准备】');
    expect(app.lastFrame()).toContain('→ Executor: codex-cli 将处理该任务');
    expect(app.lastFrame()).toContain('status: running codex-cli');
    expect(app.lastFrame()).toContain('当前任务 #');
    expect(app.lastFrame()).toContain('[RUNNING] 生成一个状态报告');

    executorDeferred.resolve({
      success: true,
      output: 'done',
      exitCode: 0,
      durationMs: 100,
    });
    await submitPromise;
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });

  it('rejects urgent top-level task intake instead of preempting through the user entrypoint', async () => {
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
      query: vi.fn()
        .mockResolvedValueOnce(semanticDurableTask('普通任务'))
        .mockResolvedValueOnce(semanticDurableTask('紧急任务')),
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

    expect(app.lastFrame()).toContain('单活跃任务限制');
    expect(app.lastFrame()).toContain(`#${runningTaskId}`);
    expect(taskEngine['taskRepo'].findByStatus('ready')).toHaveLength(0);

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

  it('keeps busy intent timeout conservative instead of queueing keyword fallback work', async () => {
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
        output: 'queued done',
        exitCode: 0,
        durationMs: 500,
      }),
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
        .mockResolvedValueOnce({ type: 'new', taskId: null, reason: '忙时 fallback 后的新任务' }),
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

    expect(app.lastFrame()).toContain('统一意图裁决置信度不足');
    expect(app.lastFrame()).toContain('intent orchestrator timeout');
    expect(taskEngine['taskRepo'].findByStatus('ready')).toHaveLength(0);

    await secondSubmit;
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
      execute: vi.fn().mockImplementation(() => piDeferred.promise),
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

    expect(app.lastFrame()).toContain('status: running codex-cli');
    expect(app.lastFrame()).not.toContain('status: running pi-agent');
    expect(defaultExecutor.execute).toHaveBeenCalledTimes(1);
    expect(piExecutor.execute).not.toHaveBeenCalled();

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
