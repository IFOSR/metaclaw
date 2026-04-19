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

describe('Round 1 memory resume acceptance', () => {
  it('keeps task-local memory ahead of global memory when a parked task resumes after preemption', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const firstDeferred = createDeferredResult();
    const urgentDeferred = createDeferredResult();
    const resumedDeferred = createDeferredResult();

    let firstExecuteResolved = false;
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn()
        .mockImplementationOnce(() => firstDeferred.promise)
        .mockImplementationOnce(() => urgentDeferred.promise)
        .mockImplementationOnce(() => resumedDeferred.promise),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn().mockImplementation(() => {
        if (!firstExecuteResolved) {
          firstExecuteResolved = true;
          firstDeferred.resolve({
            success: false,
            output: '',
            error: 'execution interrupted',
            exitCode: 1,
            durationMs: 100,
            interrupted: true,
          });
        }
      }),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({
        route: 'durable_task',
        reason: 'round 1 resume acceptance',
      }),
      resolveIntent: vi.fn().mockResolvedValue({
        type: 'new',
        taskId: null,
        reason: 'new task',
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
        sessionId: 'sess_memory_resume_acceptance',
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

    await typeAndSubmit('整理 Phoenix 项目的季度复盘，并输出成表格版周报格式');

    const primaryTask = taskRepo.findAll()[0];
    memoryEngine.addManual({
      content: '当前任务固定使用表格结构并保留风险栏目',
      scope: 'task-local',
      type: 'style',
      subject: primaryTask.id,
    });
    memoryEngine.addManual({
      content: '输出尽量短，不强制表格',
      scope: 'global',
      type: 'style',
    });

    await typeAndSubmit('紧急：先帮我总结今天的会议纪要');

    urgentDeferred.resolve({
      success: true,
      output: '会议纪要已总结',
      exitCode: 0,
      durationMs: 120,
    });
    await flushUpdates();
    await flushUpdates();

    const resumedInput = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[2][0];
    const resolvedPreferences = resumedInput.executionContextBundle.memoryContext.resolvedPreferences;

    expect(resumedInput.executionContextBundle.mode).toBe('resume-parked');
    expect(resolvedPreferences[0].scope).toBe('task-local');
    expect(resolvedPreferences[0].reason).toBe('命中当前任务局部偏好');
    expect(resolvedPreferences[1].scope).toBe('global');

    resumedDeferred.resolve({
      success: true,
      output: '季度复盘已恢复完成',
      exitCode: 0,
      durationMs: 140,
    });
    await flushUpdates();
    await flushUpdates();

    expect(app.lastFrame()).toContain('已注入 2 条偏好');
    expect(app.lastFrame()).toContain('[task-local] 当前任务固定使用表格结构并保留风险栏目');
    expect(app.lastFrame()).toContain('命中当前任务局部偏好');

    app.unmount();
    app.cleanup();
  });
});
