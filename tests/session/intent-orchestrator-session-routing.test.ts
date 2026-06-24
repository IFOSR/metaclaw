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
import type { IntentDecisionV2 } from '../../src/core/intent-orchestrator.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: { command: 'codex', timeout: 60_000 },
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

function decision(overrides: Partial<IntentDecisionV2> = {}): IntentDecisionV2 {
  return {
    interactionType: 'durable_task',
    confidence: 0.9,
    reason: '统一意图裁决',
    clarificationQuestion: null,
    risk: {
      level: 'low',
      requiresConfirmation: false,
      reasons: [],
    },
    task: {
      binding: 'new',
      taskId: null,
      control: 'none',
      scope: null,
    },
    execution: {
      mode: 'single_executor',
      complexity: 'simple',
      selectedExecutor: 'codex-cli',
      candidateExecutors: ['codex-cli'],
      requiresVerification: false,
      canModifyFiles: true,
      requiresExternalGateway: false,
    },
    hints: [],
    ...overrides,
  };
}

describe('MetaclawSession IntentOrchestrator integration', () => {
  it('routes natural language through IntentOrchestrator without directly calling legacy route or intent methods', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-intent-orchestrator');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'done',
        exitCode: 0,
        durationMs: 100,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn(),
      resolveIntent: vi.fn(),
      resolveTaskStateOwnership: vi.fn(),
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;
    const intentOrchestrator = {
      decide: vi.fn().mockResolvedValue(decision()),
    };

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_intent_orchestrator_route',
      contextRecaller,
      llmBridge,
      intentOrchestrator,
    });
    session.initialize({ resumeStartupTasks: false });

    await session.submit('实现一个普通功能', { awaitAsyncWork: true });

    expect(intentOrchestrator.decide).toHaveBeenCalledTimes(1);
    expect(llmBridge.resolveRoute).not.toHaveBeenCalled();
    expect(llmBridge.resolveIntent).not.toHaveBeenCalled();
    expect(llmBridge.resolveTaskStateOwnership).not.toHaveBeenCalled();
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().output.join('\n')).toContain('任务 #');
  });

  it('uses IntentDecisionV2 clarification without creating or executing a task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-intent-clarification');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn(),
      resolveIntent: vi.fn(),
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;
    const intentOrchestrator = {
      decide: vi.fn().mockResolvedValue(decision({
        interactionType: 'clarification',
        confidence: 0.2,
        reason: '低置信度',
        clarificationQuestion: '请明确是聊天还是创建任务。',
        task: {
          binding: 'none',
          taskId: null,
          control: 'none',
          scope: null,
        },
        execution: {
          mode: 'none',
          complexity: 'simple',
          selectedExecutor: null,
          candidateExecutors: [],
          requiresVerification: false,
          canModifyFiles: false,
          requiresExternalGateway: false,
        },
      })),
    };

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_intent_orchestrator_clarification',
      contextRecaller,
      llmBridge,
      intentOrchestrator,
    });
    session.initialize({ resumeStartupTasks: false });

    await session.submit('这个可能要处理一下', { awaitAsyncWork: true });

    expect(taskRepo.findAll()).toHaveLength(0);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(session.getSnapshot().output.join('\n')).toContain('请明确是聊天还是创建任务。');
  });

  it('blocks repo execution completion when verifier acceptance criteria lack test evidence', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-intent-verifier');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '已修改代码并完成实现。',
        exitCode: 0,
        durationMs: 100,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn(),
      resolveIntent: vi.fn(),
      resolveTaskStateOwnership: vi.fn(),
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;
    const intentOrchestrator = {
      decide: vi.fn().mockResolvedValue(decision({
        execution: {
          mode: 'single_executor',
          complexity: 'simple',
          selectedExecutor: 'codex-cli',
          candidateExecutors: ['codex-cli'],
          requiresVerification: true,
          canModifyFiles: true,
          requiresExternalGateway: false,
          primaryIntent: 'repo_execution',
          matchedBoundary: ['repo_execution'],
        },
      })),
    };

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_intent_orchestrator_verifier',
      contextRecaller,
      llmBridge,
      intentOrchestrator,
    });
    session.initialize({ resumeStartupTasks: false });

    await session.submit('修改仓库代码实现一个功能', { awaitAsyncWork: true });

    const [task] = taskRepo.findAll();
    expect(task.status).toBe('blocked');
    expect(task.summary).toBe('');
    expect(task.dependencies).toEqual([
      expect.objectContaining({
        description: '缺少仓库修改任务的测试证据或未测试说明',
        status: 'waiting',
      }),
    ]);
    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('✗ 验收未通过: 缺少仓库修改任务的测试证据或未测试说明');
    expect(output).toContain(`任务 #${task.id} 已转为阻塞`);
    expect(output).not.toContain('✓ 任务完成');
  });
});
