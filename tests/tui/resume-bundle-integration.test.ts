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

async function waitFor(assertion: () => void, attempts = 30) {
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

describe('App resume bundle integration', () => {
  it('passes a resume-parked execution context bundle to the executor when resuming a parked task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const parkedTask = taskEngine.create({ title: '行业分析', goal: '完成分析摘要' });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '被高优任务抢占', {
      done: ['报告 A 已完成'],
      pending: ['报告 B 待分析'],
      nextStep: '继续分析报告 B',
      pauseReason: '被高优任务抢占',
    });
    taskRepo.update(parkedTask.id, { lastInterruptionReason: '被任务 #task_high 抢占' });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '恢复完成',
        exitCode: 0,
        durationMs: 800,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveIntent: vi.fn().mockResolvedValue({
        type: 'reference',
        taskId: parkedTask.id,
        reason: '继续刚才的任务',
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
        sessionId: 'sess_resume',
        contextRecaller,
        llmBridge,
      })
    );

    for (const char of '继续刚才的行业分析') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }

    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();

    await waitFor(() => {
      expect(executor.execute).toHaveBeenCalled();
      const executionCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls
        .find(call => call[0].executionContextBundle?.mode === 'resume-parked');
      expect(executionCall?.[0].executionContextBundle.mode).toBe('resume-parked');
      expect(executionCall?.[0].executionContextBundle.resumeContext.lastProgress).toContain('报告 A 已完成');
    });

    app.unmount();
    app.cleanup();
  });
});
