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

async function submitLine(line: string) {
  for (const char of line) {
    await inputCapture.handler?.(char, {});
    await flushUpdates();
  }
  await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
  await flushUpdates();
  await flushUpdates();
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

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App V2 recall handling visibility', () => {
  it('shows proposal and then continues without recall confirmation', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(prefRepo, obsRepo);
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    prefRepo.insert({
      id: 'pref_project',
      type: 'domain',
      scope: 'project',
      subject: 'Phoenix',
      content: 'Phoenix 周报统一保留风险栏目和经营数据栏目',
      status: 'confirmed',
      confidence: 1,
      occurrenceCount: 3,
      sourceTasks: [],
      lastUsedAt: null,
      confirmedAt: '2026-04-20T00:00:00Z',
      createdAt: '2026-04-20T00:00:00Z',
      updatedAt: '2026-04-20T00:00:00Z',
    });

    const parkedTask = taskEngine.create({
      title: 'Phoenix 周报整理',
      goal: '继续整理 Phoenix 周报并补齐经营数据',
    });
    taskRepo.update(parkedTask.id, {
      status: 'parked',
      summary: '已整理风险栏目，待补经营数据',
      snapshots: [{
        done: ['已整理风险栏目'],
        pending: ['待补经营数据'],
        nextStep: '补齐经营数据并输出最终周报',
        pauseReason: '等待经营数据',
        createdAt: '2026-04-20T00:00:00Z',
      }],
      prioritySignals: {
        dueAt: null,
        isReady: true,
        progressRatio: 0.8,
        blocksOthers: false,
        idleHours: 3,
      },
      lastInterruptionReason: '等待经营数据',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'Phoenix 周报已完成',
        exitCode: 0,
        durationMs: 200,
      }),
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
        sessionId: 'sess_v2_recall_review_tui',
        contextRecaller,
        llmBridge,
      }),
    );

    await waitFor(() => {
      expect(app.lastFrame()).toContain('操作提案');
      expect(app.lastFrame()).toContain('恢复');
    });

    await waitFor(() => {
      expect(app.lastFrame()).not.toContain('记忆召回确认');
      expect(app.lastFrame()).toContain('已注入 1 条偏好');
      expect(executor.execute).toHaveBeenCalledTimes(1);
    });

    app.unmount();
    app.cleanup();
  });
});
