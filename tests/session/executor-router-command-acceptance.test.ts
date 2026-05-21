import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { MemoryEngine } from '../../src/core/memory-engine.js';
import { OrchestrationEngine } from '../../src/core/orchestration.js';
import { ContextRecaller } from '../../src/core/context-recaller.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { LlmBridge } from '../../src/core/llm-bridge.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: { command: 'codex', timeout: 60_000 },
    orchestration: { reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5 },
    ui: { language: 'zh-CN', dashboard_on_start: false },
  };
}

describe('executor router command acceptance', () => {
  it('routes through session commands and records feedback', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-executor-router');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn(),
      resolveIntent: vi.fn(),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration: new OrchestrationEngine(taskEngine),
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_executor_router',
      contextRecaller: new ContextRecaller(db),
      llmBridge,
    });

    session.initialize();
    await session.submit('/executor profile upsert legal-contract --domains legal,contract --capabilities contract_review,risk_matrix --risk high --success 0.9');
    await session.submit('/executor route 请审查合同条款并输出风险矩阵');
    await session.submit('/executor route-feedback');

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('已更新 Executor Profile：legal-contract');
    expect(output).toContain('Route Decision：legal-contract');
    expect(output).toContain('Executor Route Feedback');
  });

  it('auto-registers local executors and records route decisions before task execution', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-executor-route-exec');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '代码任务已完成',
        exitCode: 0,
        durationMs: 50,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: 'coding task' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: 'new task' }),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration: new OrchestrationEngine(taskEngine),
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_executor_router_exec',
      contextRecaller: new ContextRecaller(db),
      llmBridge,
    });

    session.initialize();
    await session.submit('请实现一个 TypeScript 单元测试并修复代码', { awaitAsyncWork: true });

    const profiles = db.prepare('SELECT name FROM executor_profiles ORDER BY name ASC').all() as Array<{ name: string }>;
    expect(profiles.map(row => row.name)).toEqual(expect.arrayContaining(['codex-cli']));

    const route = db.prepare('SELECT selected_executor, action, user_input FROM executor_route_events ORDER BY created_at DESC LIMIT 1').get() as {
      selected_executor: string;
      action: string;
      user_input: string;
    };
    expect(route).toEqual(expect.objectContaining({
      selected_executor: 'codex-cli',
      user_input: '请实现一个 TypeScript 单元测试并修复代码',
    }));
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('routes research automation tasks to Hermes instead of the default executor', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-executor-route-hermes');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const defaultExecutor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '默认执行器不应执行',
        exitCode: 0,
        durationMs: 50,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const hermesExecutor: ExecutorAdapter = {
      name: 'hermes-agent',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'Hermes 已完成研究自动化任务',
        exitCode: 0,
        durationMs: 50,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: 'research automation task' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: 'new task' }),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration: new OrchestrationEngine(taskEngine),
      executor: defaultExecutor,
      db,
      config: createConfig(),
      sessionId: 'sess_executor_router_hermes',
      contextRecaller: new ContextRecaller(db),
      llmBridge,
      executorFactory: (name) => name === 'hermes-agent' ? hermesExecutor : null,
      availableExecutorCommands: new Set(['codex', 'hermes']),
    });

    session.initialize();
    await session.submit('请调研这个方案并进行自动化分析，输出报告', { awaitAsyncWork: true });

    const route = db.prepare('SELECT selected_executor, action, result FROM executor_route_events ORDER BY created_at DESC LIMIT 1').get() as {
      selected_executor: string;
      action: string;
      result: string | null;
    };
    expect(route).toEqual(expect.objectContaining({
      selected_executor: 'hermes-agent',
      action: 'auto_dispatch',
      result: 'success',
    }));
    expect(defaultExecutor.execute).not.toHaveBeenCalled();
    expect(hermesExecutor.execute).toHaveBeenCalledTimes(1);

    const interaction = db.prepare('SELECT executor_used, system_output FROM interactions ORDER BY created_at DESC LIMIT 1').get() as {
      executor_used: string;
      system_output: string;
    };
    expect(interaction.executor_used).toBe('hermes-agent');
    expect(interaction.system_output).toContain('Hermes');
  });
});
