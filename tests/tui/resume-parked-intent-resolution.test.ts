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
import { LlmBridge } from '../../src/core/llm-bridge.js';
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';

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

async function waitForExecutorCall(execute: ReturnType<typeof vi.fn>) {
  for (let index = 0; index < 20; index += 1) {
    if (execute.mock.calls.length > 0) {
      return;
    }
    await flushUpdates();
  }
}

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App parked task intent resolution', () => {
  it('resumes the parked task instead of creating a generic new task for explicit parked-resume input', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const finishedTask = taskEngine.create({
      title: '比亚迪 vs 宁德时代 新能源电池份额调研',
      goal: '分析两家公司在新能源电池层面的市场份额',
    });
    taskEngine.transition(finishedTask.id, 'ready');
    taskEngine.transition(finishedTask.id, 'running');
    taskRepo.update(finishedTask.id, {
      summary: '宁德时代份额高于比亚迪',
    });
    taskEngine.transition(finishedTask.id, 'done');

    const llmBridge = new LlmBridge('codex');
    let parkedTaskId = '';
    const querySpy = vi.spyOn(llmBridge, 'query')
      .mockImplementation(async (prompt: string) => {
        if (prompt.includes('判断用户输入是否是在要求恢复')) {
          return `{"action":"resume","taskId":"${parkedTaskId}","confidence":0.94,"reason":"用户明确要求继续之前挂起的任务"}`;
        }
        return '{"priority":"normal","reason":"测试默认优先级"}';
      });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '继续输出 memory 调研内容',
        exitCode: 0,
        durationMs: 700,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_resume_parked_intent',
        contextRecaller,
        llmBridge,
        availableExecutorCommands: new Set(['codex']),
      }),
    );

    const parkedTask = taskEngine.create({
      title: '给 agent 增加 memory 的开源调研',
      goal: '充分调研 agent memory 的设计与开源方案',
    });
    parkedTaskId = parkedTask.id;
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '被更高优先级任务抢占：跟进任务恢复', {
      done: ['已整理 memory 分类与主流开源方向'],
      pending: ['补齐开源项目对比表'],
      nextStep: '继续完善 memory 方案对比',
      pauseReason: '被更高优先级任务抢占',
    });
    taskRepo.update(parkedTask.id, {
      lastInterruptionReason: '被更高优先级任务抢占：跟进任务恢复',
      summary: '已整理 memory 分类与主流开源方向',
    });

    for (const char of '继续之前挂起的任务') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }

    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();
    await waitForExecutorCall(executor.execute as ReturnType<typeof vi.fn>);

    expect(querySpy).toHaveBeenCalled();
    expect((executor.execute as ReturnType<typeof vi.fn>).mock.calls.some(call =>
      call[0].task.id === parkedTask.id
      && call[0].executionContextBundle.mode === 'resume-parked'
    )).toBe(true);

    app.unmount();
    app.cleanup();
  });
});
