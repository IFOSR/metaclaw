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
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { SkillUsageEventRepo } from '../../src/storage/skill-usage-event-repo.js';

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
    ui: { language: 'zh-CN', dashboard_on_start: false },
  };
}

describe('Session skill usage observability', () => {
  it('records executor reported SkillUsageEvents and shows throttled user-visible progress', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async (input) => {
        input.onProgress?.({
          kind: 'skill',
          text: '开始按 TDD 执行',
          skillEvent: {
            eventType: 'skill_started',
            skillName: 'test-driven-development',
            skillVersion: '1.1.0',
            message: '开始按 TDD 执行',
            payload: { phase: 'RED' },
          },
        });
        input.onProgress?.({
          kind: 'skill',
          text: 'RED 测试已创建',
          skillEvent: {
            eventType: 'skill_progress',
            skillName: 'test-driven-development',
            skillVersion: '1.1.0',
            message: 'RED 测试已创建',
            payload: { phase: 'RED' },
          },
        });
        input.onProgress?.({
          kind: 'skill',
          text: 'RED 测试已创建',
          skillEvent: {
            eventType: 'skill_progress',
            skillName: 'test-driven-development',
            skillVersion: '1.1.0',
            message: 'RED 测试已创建',
            payload: { phase: 'RED' },
          },
        });
        input.onProgress?.({
          kind: 'skill',
          text: 'TDD 流程完成',
          skillEvent: {
            eventType: 'skill_completed',
            skillName: 'test-driven-development',
            skillVersion: '1.1.0',
            message: 'TDD 流程完成',
            payload: { tests: 'passed' },
          },
        });
        return { success: true, output: '完成', exitCode: 0, durationMs: 100 };
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: '明确任务' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: '新任务' }),
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_skill_usage',
      contextRecaller,
      llmBridge,
    });

    await session.submit('用 TDD 实现一个小功能', { awaitAsyncWork: true });

    const events = new SkillUsageEventRepo(db).listByTask(taskRepo.findByStatus('done')[0].id);
    expect(events.map(event => event.eventType)).toEqual(['skill_started', 'skill_progress', 'skill_progress', 'skill_completed']);
    expect(events[0].executionId).toMatch(/^exec_/);
    expect(events[0].executorName).toBe('codex-cli');

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('🛠️ #');
    expect(output).toContain('Skill test-driven-development: 开始按 TDD 执行');
    expect(output.match(/RED 测试已创建/g)).toHaveLength(1);
    expect(output).toContain('Skill test-driven-development: TDD 流程完成');
  });
});
