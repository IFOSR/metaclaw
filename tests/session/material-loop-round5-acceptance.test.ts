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
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { LlmBridge } from '../../src/core/llm-bridge.js';
import { runScriptedSession } from '../../src/session/scripted-session.js';

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

describe('Round 5 material loop acceptance', () => {
  it('keeps multiple attached materials visible in the task view through the scripted flow', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'Phoenix 周报结论：主线推进稳定，风险集中在联调和测试数据。',
        exitCode: 0,
        durationMs: 180,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: '明确工作任务' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: '新任务' }),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const result = await runScriptedSession({
      inputs: [
        '整理 Phoenix 项目的周报，输出一个简短结论',
        '/attach {{last_task_id}} fixture-a.md fixture-b.md',
        '/task {{last_task_id}}',
      ],
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_round5_materials',
      contextRecaller,
      llmBridge,
    });

    const output = result.output.join('\n');
    expect(output).toContain('已关联 2 个文件到任务');
    expect(output).toContain('关联材料: fixture-a.md, fixture-b.md');
  });
});
