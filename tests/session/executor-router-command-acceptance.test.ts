import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
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

function createSession(input: {
  db: Database.Database;
  taskEngine: TaskEngine;
  memoryEngine: MemoryEngine;
  executor: ExecutorAdapter;
  sessionId: string;
  llmBridge?: Partial<LlmBridge>;
}) {
  return new MetaclawSession({
    taskEngine: input.taskEngine,
    memoryEngine: input.memoryEngine,
    orchestration: new OrchestrationEngine(input.taskEngine),
    executor: input.executor,
    db: input.db,
    config: createConfig(),
    sessionId: input.sessionId,
    contextRecaller: new ContextRecaller(input.db),
    llmBridge: {
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: 'durable task' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: 'new task' }),
      rankInteractions: vi.fn().mockResolvedValue([]),
      ...input.llmBridge,
    } as unknown as LlmBridge,
  });
}

describe('planner-first executor command acceptance', () => {
  it('guides users through executor AgentClass registration and persists runtime binding', async () => {
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
    const session = createSession({ db, taskEngine, memoryEngine, executor, sessionId: 'sess_agent_class_register_wizard' });

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
      SELECT name, kind, domains_json, capabilities_json, runtime_command, runtime_args_json,
             runtime_check_command, availability
      FROM agent_classes WHERE name = ?
    `).get('research-bot') as {
      name: string;
      kind: string;
      domains_json: string;
      capabilities_json: string;
      runtime_command: string;
      runtime_args_json: string;
      runtime_check_command: string;
      availability: string;
    };

    expect(row).toEqual(expect.objectContaining({
      name: 'research-bot',
      kind: 'executor',
      runtime_command: 'research-bot',
      runtime_check_command: 'research-bot --version',
      availability: 'available',
    }));
    expect(JSON.parse(row.runtime_args_json)).toEqual(['run', '--prompt', '{prompt}']);
    expect(JSON.parse(row.domains_json)).toEqual(['research', 'reporting']);
    expect(JSON.parse(row.capabilities_json)).toEqual(['research', 'report_generation']);

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('Executor AgentClass registration wizard started');
    expect(output).toContain('Registered Executor AgentClass: research-bot');
    expect(output).toContain('This executor class can now back executor work units');
  });

  it('supports one-line AgentClass registration with quoted runtime args', async () => {
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
    const session = createSession({ db, taskEngine, memoryEngine, executor, sessionId: 'sess_agent_class_register_oneline' });

    session.initialize();
    await session.submit('/executor register research-bot --command research-bot --args "run --prompt {prompt}" --check "research-bot --version" --domains research --capabilities report_generation');

    const row = db.prepare('SELECT runtime_args_json, runtime_check_command FROM agent_classes WHERE name = ?').get('research-bot') as {
      runtime_args_json: string;
      runtime_check_command: string;
    };

    expect(JSON.parse(row.runtime_args_json)).toEqual(['run', '--prompt', '{prompt}']);
    expect(row.runtime_check_command).toBe('research-bot --version');
  });

  it('routes through planner preview commands without writing route events', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-planner-preview');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const session = createSession({ db, taskEngine, memoryEngine, executor, sessionId: 'sess_planner_preview' });

    session.initialize();
    await session.submit('/executor profile upsert legal-contract --domains legal,contract --capabilities contract_review,risk_matrix --risk high --success 0.9');
    await session.submit('/executor route 请审查合同条款并输出风险矩阵');
    await session.submit('/executor route-feedback');

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('Updated Executor AgentClass: legal-contract');
    expect(output).toContain('Planner Route Preview');
    expect(output).toContain('candidateAgentClasses=legal-contract');
    expect(output).toContain('No planner task events recorded yet');
    expect(db.prepare('SELECT COUNT(*) AS count FROM executor_route_events').get()).toEqual({ count: 0 });
  });

  it('persists planner subtasks and work unit claims before execution', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-planner-exec');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'code task done',
        exitCode: 0,
        durationMs: 50,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const session = createSession({ db, taskEngine, memoryEngine, executor, sessionId: 'sess_planner_exec' });

    session.initialize();
    await session.submit('请实现一个 TypeScript 单元测试并修复代码', { awaitAsyncWork: true });

    const agentClasses = db.prepare('SELECT name FROM agent_classes ORDER BY name ASC').all() as Array<{ name: string }>;
    expect(agentClasses.map(row => row.name)).toEqual(expect.arrayContaining(['codex-cli', 'planner']));

    const subtasks = db.prepare('SELECT status, expected_output FROM subtasks ORDER BY created_at ASC').all() as Array<{
      status: string;
      expected_output: string;
    }>;
    expect(subtasks).toEqual([expect.objectContaining({ status: 'done', expected_output: 'patch' })]);

    const workUnitEvents = db.prepare('SELECT event_type FROM work_unit_events ORDER BY created_at ASC').all() as Array<{ event_type: string }>;
    expect(workUnitEvents.map(row => row.event_type)).toEqual(expect.arrayContaining(['claimed', 'running', 'released']));
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('uses the fixed executor work unit instead of racing or choosing peer executors', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-fixed-executor');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const defaultExecutor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'default executor completed research',
        exitCode: 0,
        durationMs: 50,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const piExecutor: ExecutorAdapter = {
      name: 'pi-agent',
      execute: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration: new OrchestrationEngine(taskEngine),
      executor: defaultExecutor,
      db,
      config: createConfig(),
      sessionId: 'sess_fixed_executor',
      contextRecaller: new ContextRecaller(db),
      llmBridge: {
        resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: 'research automation task' }),
        resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: 'new task' }),
        rankInteractions: vi.fn().mockResolvedValue([]),
      } as unknown as LlmBridge,
      executorFactory: name => name === 'pi-agent' ? piExecutor : null,
      availableExecutorCommands: new Set(['codex', 'pi']),
    });

    session.initialize();
    await session.submit('请调研这个方案并进行自动化分析，输出报告', { awaitAsyncWork: true });

    expect(defaultExecutor.execute).toHaveBeenCalledTimes(1);
    expect(piExecutor.execute).not.toHaveBeenCalled();
    expect(db.prepare('SELECT agent_class_name, state FROM work_units WHERE id = ?').get('executor-1')).toEqual({
      agent_class_name: 'codex-cli',
      state: 'idle',
    });
  });

  it('blocks failed executor subtasks for planner recovery instead of platform fallback', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-no-platform-fallback');
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
    const session = createSession({ db, taskEngine, memoryEngine, executor, sessionId: 'sess_no_platform_fallback' });

    session.initialize();
    await session.submit('请实现一个 TypeScript 单元测试并修复代码', { awaitAsyncWork: true });

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('✗ 执行失败');
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(taskRepo.findByStatus('blocked')).toHaveLength(1);
    expect(db.prepare('SELECT status FROM subtasks ORDER BY created_at DESC LIMIT 1').get()).toEqual({ status: 'blocked' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM executor_route_events').get()).toEqual({ count: 0 });
  });
});
