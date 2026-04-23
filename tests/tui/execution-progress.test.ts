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
import type { Config } from '../../src/core/types.js';
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

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App execution progress', () => {
  it('shows execution preparation and executor progress lines while a task is running', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    memoryEngine.addManual({
      content: 'Phoenix 项目材料统一使用 Phoenix 术语体系',
      scope: 'project',
      type: 'domain',
      subject: 'Phoenix',
    });
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async (input) => {
        input.onProgress?.({ kind: 'status', text: '已启动 codex-cli 执行器' });
        input.onProgress?.({ kind: 'log', text: '正在检索市场份额数据' });
        return {
          success: true,
          output: '调研完成',
          exitCode: 0,
          durationMs: 500,
        };
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({
        route: 'durable_task',
        reason: '明确调研任务',
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
        sessionId: 'sess_execution_progress',
        contextRecaller,
        llmBridge,
      }),
    );

    for (const char of '整理 Phoenix 项目周报') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();
    await flushUpdates();

    expect(app.lastFrame()).toContain('记忆召回确认');

    await inputCapture.handler?.('y', {});
    await flushUpdates();
    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();
    await flushUpdates();

    expect(app.lastFrame()).toContain('【提取最近历史记录上下文】');
    expect(app.lastFrame()).toContain('【构建执行上下文】');
    expect(app.lastFrame()).toContain('【执行上下文准备完成】');
    expect(app.lastFrame()).not.toContain('→ 正在回忆任务 #');
    expect(app.lastFrame()).not.toContain('→ 已召回 ');
    expect(app.lastFrame()).not.toContain('→ 正在构建任务 #');
    expect(app.lastFrame()).not.toContain('→ 执行上下文已准备完成');
    expect(app.lastFrame()).toContain('· #');
    expect(app.lastFrame()).toContain('已启动 codex-cli 执行器');
    expect(app.lastFrame()).toContain('正在检索市场份额数据');
    expect(app.lastFrame()).toContain('  · 已注入');
    expect(app.lastFrame()).toContain('confidence=');
    expect(app.lastFrame()).toContain('命中原因');

    app.unmount();
    app.cleanup();
  });

  it('shows a waiting executor hint while a task is running but no fresh progress arrived yet', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 240));
        return {
          success: true,
          output: '调研完成',
          exitCode: 0,
          durationMs: 280,
        };
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({
        route: 'durable_task',
        reason: '明确调研任务',
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
        sessionId: 'sess_execution_waiting_hint',
        contextRecaller,
        llmBridge,
      }),
    );

    for (const char of '整理 Phoenix 项目周报') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    const submitPromise = inputCapture.handler?.('', { return: true }) ?? Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 140));
    await flushUpdates();

    expect(app.lastFrame()).toContain('正在等待执行器返回');

    await submitPromise;
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });
});
