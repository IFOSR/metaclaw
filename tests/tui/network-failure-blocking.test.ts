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

async function waitUntil(assertion: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!assertion()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for expected TUI state');
    }
    await flushUpdates();
  }
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
      primaryIntent: 'general',
      matchedBoundary: ['general'],
      reason,
      candidates: [{ executorName: 'codex-cli', score: 0.9, reason, matchedBoundary: ['general'] }],
      rejected: [],
    },
  });
}

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App network failure blocking', () => {
  it('moves a task into blocked with an explicit unblock hint after network failure', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: '执行器网络连接失败，请检查网络或代理配置',
        exitCode: 1,
        durationMs: 800,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      query: vi.fn().mockResolvedValue(semanticDurableTask('明确测试任务')),
      resolveRoute: vi.fn().mockResolvedValue({
        route: 'durable_task',
        reason: '明确测试任务',
      }),
      resolveIntent: vi.fn().mockResolvedValue({
        type: 'new',
        taskId: null,
        reason: '新任务',
      }),
      resolveTaskPriority: vi.fn().mockResolvedValue({
        priority: 'normal',
        reason: '默认优先级',
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
        sessionId: 'sess_network_block',
        contextRecaller,
        llmBridge,
        availableExecutorCommands: new Set(['codex']),
      }),
    );

    for (const char of '调研 agent memory 框架') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await waitUntil(() => taskRepo.findByStatus('blocked').length > 0);
    await waitUntil(() => app.lastFrame()?.includes('! 执行失败: 执行器网络连接失败，请检查网络或代理配置') ?? false);

    const blockedTask = taskRepo.findByStatus('blocked')[0];
    expect(blockedTask).toBeTruthy();
    expect(blockedTask.dependencies[0]?.description).toBe('执行器网络连接失败，请检查网络或代理配置');
    expect(app.lastFrame()).toContain('! 执行失败: 执行器网络连接失败，请检查网络或代理配置');
    expect(app.lastFrame()).toContain(`任务 #${blockedTask.id} 已转为阻塞`);
    expect(app.lastFrame()).toContain(`/task ${blockedTask.id} unblock`);

    app.unmount();
    app.cleanup();
  });

  it('moves a task into blocked with an idle-timeout-specific hint after executor inactivity', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: '执行器空闲超时，长时间无输出或状态变化，请检查执行器是否卡住',
        exitCode: 1,
        durationMs: 1800,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      query: vi.fn().mockResolvedValue(semanticDurableTask('明确测试任务')),
      resolveRoute: vi.fn().mockResolvedValue({
        route: 'durable_task',
        reason: '明确测试任务',
      }),
      resolveIntent: vi.fn().mockResolvedValue({
        type: 'new',
        taskId: null,
        reason: '新任务',
      }),
      resolveTaskPriority: vi.fn().mockResolvedValue({
        priority: 'normal',
        reason: '默认优先级',
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
        sessionId: 'sess_idle_timeout_block',
        contextRecaller,
        llmBridge,
        availableExecutorCommands: new Set(['codex']),
      }),
    );

    for (const char of '生成 HTML 幻灯片') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await waitUntil(() => taskRepo.findByStatus('blocked').length > 0);
    await waitUntil(() => app.lastFrame()?.includes('执行器长时间没有输出或状态变化') ?? false);

    const blockedTask = taskRepo.findByStatus('blocked')[0];
    expect(blockedTask).toBeTruthy();
    expect(blockedTask.dependencies[0]?.description).toBe('执行器空闲超时，长时间无输出或状态变化，请检查执行器是否卡住');
    expect(app.lastFrame()).toContain('执行器长时间没有输出或状态变化');
    expect(app.lastFrame()).toContain(`/task ${blockedTask.id} unblock`);

    app.unmount();
    app.cleanup();
  });
});
