import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/core/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
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
  it('guides users through executor registration and persists runtime binding', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-executor-wizard');
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
      sessionId: 'sess_executor_register_wizard',
      contextRecaller: new ContextRecaller(db),
      llmBridge,
    });

    session.initialize();
    await session.submit('/executor register wizard');
    await session.submit('research-bot');
    await session.submit('manual');
    await session.submit('research-bot');
    await session.submit('run --prompt {prompt}');
    await session.submit('research-bot --version');
    await session.submit('research,reporting');
    await session.submit('research,report_generation');
    await session.submit('y');

    const row = db.prepare(`
      SELECT name, domains_json, capabilities_json, runtime_command, runtime_args_json,
             runtime_check_command, availability
      FROM executor_profiles WHERE name = ?
    `).get('research-bot') as {
      name: string;
      domains_json: string;
      capabilities_json: string;
      runtime_command: string;
      runtime_args_json: string;
      runtime_check_command: string;
      availability: string;
    };

    expect(row).toEqual(expect.objectContaining({
      name: 'research-bot',
      runtime_command: 'research-bot',
      runtime_check_command: 'research-bot --version',
      availability: 'available',
    }));
    expect(JSON.parse(row.runtime_args_json)).toEqual(['run', '--prompt', '{prompt}']);
    expect(JSON.parse(row.domains_json)).toEqual(['research', 'reporting']);
    expect(JSON.parse(row.capabilities_json)).toEqual(['research', 'report_generation']);

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('Executor 注册向导已启动');
    expect(output).toContain('已注册 Executor：research-bot');
    expect(output).toContain('调度前会执行安装检测');
  });

  it('supports one-line executor registration with quoted runtime args', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-executor-oneline');
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
      sessionId: 'sess_executor_register_oneline',
      contextRecaller: new ContextRecaller(db),
      llmBridge,
    });

    session.initialize();
    await session.submit('/executor register research-bot --command research-bot --args "run --prompt {prompt}" --check "research-bot --version" --domains research --capabilities report_generation');

    const row = db.prepare('SELECT runtime_args_json, runtime_check_command FROM executor_profiles WHERE name = ?').get('research-bot') as {
      runtime_args_json: string;
      runtime_check_command: string;
    };

    expect(JSON.parse(row.runtime_args_json)).toEqual(['run', '--prompt', '{prompt}']);
    expect(row.runtime_check_command).toBe('research-bot --version');
  });

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

  it('dispatches research tasks to the primary executor without racing peers', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-executor-route-pi');
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
    let resolvePi!: (value: {
      success: true;
      output: string;
      exitCode: number;
      durationMs: number;
    }) => void;
    const piResult = new Promise<{
      success: true;
      output: string;
      exitCode: number;
      durationMs: number;
    }>(resolve => {
      resolvePi = resolve;
    });
    const piExecutor: ExecutorAdapter = {
      name: 'pi-agent',
      execute: vi.fn().mockImplementation(() => piResult),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const hermesExecutor: ExecutorAdapter = {
      name: 'hermes-agent',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'Hermes Agent 不应执行',
        exitCode: 0,
        durationMs: 500,
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
      sessionId: 'sess_executor_router_pi',
      contextRecaller: new ContextRecaller(db),
      llmBridge,
      executorFactory: (name) => {
        if (name === 'pi-agent') return piExecutor;
        if (name === 'hermes-agent') return hermesExecutor;
        return null;
      },
      availableExecutorCommands: new Set(['codex', 'pi', 'hermes']),
    });

    session.initialize();
    const submitPromise = session.submit('请调研这个方案并进行自动化分析，输出报告', { awaitAsyncWork: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(session.getSnapshot().runtimeState.runningExecutorName).toBe('pi-agent');

    resolvePi({
      success: true,
      output: 'Pi Agent 已完成研究自动化任务',
      exitCode: 0,
      durationMs: 50,
    });
    await submitPromise;
    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('pi-agent (auto_dispatch');
    expect(output).toContain('single_executor');
    expect(output).toContain('memory_ops');
    expect(output).not.toContain('pi-agent + hermes-agent');
    expect(output).not.toContain('hermes-agent');

    const route = db.prepare('SELECT selected_executor, action, result FROM executor_route_events ORDER BY created_at DESC LIMIT 1').get() as {
      selected_executor: string;
      action: string;
      result: string | null;
    };
    expect(route).toEqual(expect.objectContaining({
      selected_executor: 'pi-agent',
      action: 'auto_dispatch',
      result: 'success',
    }));
    expect(defaultExecutor.execute).not.toHaveBeenCalled();
    expect(piExecutor.execute).toHaveBeenCalledTimes(1);
    expect(hermesExecutor.execute).not.toHaveBeenCalled();
    expect(hermesExecutor.abort).not.toHaveBeenCalled();

    const interaction = db.prepare('SELECT executor_used, system_output FROM interactions ORDER BY created_at DESC LIMIT 1').get() as {
      executor_used: string;
      system_output: string;
    };
    expect(interaction.executor_used).toBe('pi-agent');
    expect(interaction.system_output).toContain('Pi Agent');
    expect(session.getSnapshot().runtimeState.runningExecutorName).toBeNull();
  });

  it('falls back to Codex CLI before blocking a failed non-Codex executor task', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-executor-route-codex-fallback');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const defaultExecutor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'Codex CLI 兜底完成调研报告',
        exitCode: 0,
        durationMs: 80,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const piExecutor: ExecutorAdapter = {
      name: 'pi-agent',
      execute: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'executor idle timeout',
        exitCode: 1,
        durationMs: 900_000,
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
      sessionId: 'sess_executor_router_codex_fallback',
      contextRecaller: new ContextRecaller(db),
      llmBridge,
      executorFactory: (name) => {
        if (name === 'pi-agent') return piExecutor;
        return null;
      },
      availableExecutorCommands: new Set(['codex', 'pi']),
    });

    session.initialize();
    await session.submit('请调研 pi agent 并输出 Markdown 报告', { awaitAsyncWork: true });

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('→ pi-agent failed: executor idle timeout');
    expect(output).toContain('Codex CLI 兜底完成调研报告');
    expect(piExecutor.execute).toHaveBeenCalledTimes(1);
    expect(defaultExecutor.execute).toHaveBeenCalledTimes(1);
    expect(taskRepo.findByStatus('blocked')).toHaveLength(0);
    expect(taskRepo.findByStatus('done')).toHaveLength(1);

    const route = db.prepare('SELECT selected_executor, result FROM executor_route_events ORDER BY created_at DESC LIMIT 1').get() as {
      selected_executor: string;
      result: string | null;
    };
    expect(route).toEqual(expect.objectContaining({
      selected_executor: 'pi-agent',
      result: 'fallback_success',
    }));

    const interaction = db.prepare('SELECT executor_used, system_output FROM interactions ORDER BY created_at DESC LIMIT 1').get() as {
      executor_used: string;
      system_output: string;
    };
    expect(interaction.executor_used).toBe('codex-cli');
    expect(interaction.system_output).toContain('Codex CLI 兜底完成');
  });

  it('does not fallback recursively when Codex CLI fails', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-executor-route-codex-no-loop');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'executor idle timeout',
        exitCode: 1,
        durationMs: 900_000,
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
      sessionId: 'sess_executor_router_codex_no_loop',
      contextRecaller: new ContextRecaller(db),
      llmBridge,
    });

    session.initialize();
    await session.submit('请实现一个 TypeScript 单元测试并修复代码', { awaitAsyncWork: true });

    const output = session.getSnapshot().output.join('\n');
    expect(output).not.toContain('改派给 codex-cli 兜底执行同一任务');
    expect(output).toContain('✗ 执行失败: executor idle timeout');
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(taskRepo.findByStatus('blocked')).toHaveLength(1);
  });
});
