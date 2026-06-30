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

function semanticDirectReply(reason: string) {
  return JSON.stringify({
    interactionType: 'direct_reply',
    confidence: 0.9,
    shouldAskBeforeActing: false,
    ambiguity: [],
    risk: 'low',
    reason,
    clarificationQuestion: null,
    taskBinding: { type: 'none', taskId: null, reason },
    taskControl: null,
    executorDecision: null,
  });
}

function semanticConversationFollowUp(reason: string) {
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
      matchedBoundary: ['conversation_follow_up'],
      reason,
      candidates: [{ executorName: 'codex-cli', score: 0.9, reason, matchedBoundary: ['conversation_follow_up'] }],
      rejected: [],
    },
  });
}

function flushUpdates() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function typeAndSubmit(text: string) {
  await inputCapture.handler?.(text, {});
  await flushUpdates();

  await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
  await flushUpdates();
  await flushUpdates();
}

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App task-boundary visibility', () => {
  it('explains when a conversation-derived follow-up becomes a new task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    let parkedTaskId = '';

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '三点结论：1. 强模型减少脚手架；2. 任务状态仍需系统层管理；3. 调度和恢复最难被替代。',
        exitCode: 0,
        durationMs: 90,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      query: vi.fn()
        .mockResolvedValueOnce(semanticDirectReply('普通讨论'))
        .mockResolvedValueOnce(semanticConversationFollowUp('按当前对话创建跟进任务')),
      resolveRoute: vi.fn()
        .mockResolvedValueOnce({
          route: 'conversation',
          reason: '普通讨论',
        })
        .mockResolvedValueOnce({
          route: 'task_control',
          reason: '因为提到了刚才，误判为旧任务控制',
        }),
      resolveIntent: vi.fn().mockImplementation(async () => ({
        type: 'reference',
        taskId: parkedTaskId,
        reason: '误判为恢复旧 parked 任务',
      })),
    } as unknown as LlmBridge;

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_task_boundary_visibility_followup',
        contextRecaller,
        llmBridge,
        executorFactory: () => executor,
      }),
    );

    const parkedTask = taskEngine.create({
      title: '旧的 memory 调研任务',
      goal: '继续完善 memory 方向的开源项目对比',
    });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '用户手动暂停', {
      done: ['已整理 memory 分类'],
      pending: ['继续补齐开源项目对比'],
      nextStep: '继续完善方案对比',
      pauseReason: '用户手动暂停',
    });
    taskRepo.update(parkedTask.id, {
      lastInterruptionReason: '用户手动暂停',
      summary: '已整理 memory 分类',
      prioritySignals: {
        ...parkedTask.prioritySignals,
        isReady: false,
      },
    });
    parkedTaskId = parkedTask.id;

    await typeAndSubmit('未来随着基座模型的能力越来越强，是否还需要 harness');
    await typeAndSubmit('把刚才那段回答整理成三点结论');

    expect(app.lastFrame()).toContain('按当前对话创建跟进任务');
    expect(app.lastFrame()).not.toContain(`关联到任务 #${parkedTaskId}`);

    app.unmount();
    app.cleanup();
  });

  it('explains when a short continuation stays in conversation mode', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const parkedTask = taskEngine.create({
      title: '旧的 memory 调研任务',
      goal: '继续完善 memory 方向的开源项目对比',
    });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '用户手动暂停', {
      done: ['已整理 memory 分类'],
      pending: ['继续补齐开源项目对比'],
      nextStep: '继续完善方案对比',
      pauseReason: '用户手动暂停',
    });
    taskRepo.update(parkedTask.id, {
      lastInterruptionReason: '用户手动暂停',
      summary: '已整理 memory 分类',
      prioritySignals: {
        ...parkedTask.prioritySignals,
        isReady: false,
      },
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '最容易被替代的是通用 prompt 编排，最难被替代的是调度、状态与恢复。',
        exitCode: 0,
        durationMs: 90,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      query: vi.fn()
        .mockResolvedValueOnce(semanticDirectReply('普通讨论'))
        .mockResolvedValueOnce(semanticDirectReply('延续当前对话，不恢复旧任务')),
      resolveRoute: vi.fn()
        .mockResolvedValueOnce({
          route: 'conversation',
          reason: '普通讨论',
        })
        .mockResolvedValueOnce({
          route: 'task_control',
          reason: '误判为继续已有任务',
        }),
      resolveIntent: vi.fn().mockResolvedValue({
        type: 'reference',
        taskId: parkedTask.id,
        reason: '误判为恢复旧 parked 任务',
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
        sessionId: 'sess_task_boundary_visibility_conversation',
        contextRecaller,
        llmBridge,
        executorFactory: () => executor,
      }),
    );

    await typeAndSubmit('未来随着基座模型的能力越来越强，是否还需要 harness');
    await typeAndSubmit('可以，继续');

    expect(app.lastFrame()).toContain('延续当前对话，不恢复旧任务');
    expect(app.lastFrame()).not.toContain(`关联到任务 #${parkedTask.id}`);

    app.unmount();
    app.cleanup();
  });
});
