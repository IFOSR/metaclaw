import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskEngine } from '../../src/core/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { LlmBridge } from '../../src/core/llm-bridge.js';
import { ResumeContextBuilder } from '../../src/memory/resume-context-builder.js';

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

describe('Round 11 web fetch acceptance', () => {
  it('fetches readable text from web link materials and exposes it to the executor context', async () => {
    const html = '<html><head><title>Phoenix Weekly</title></head><body><main>本周完成 Phoenix 核心模块联调，当前风险在跨团队依赖。</main></body></html>';
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const builder = new ResumeContextBuilder(taskEngine, memoryEngine, contextRecaller);

    const task = taskEngine.create({
      title: 'Phoenix 周报整理',
      goal: '整理 Phoenix 周报',
      resources: [url],
    });

    const bundle = await builder.build({
      taskId: task.id,
      mode: 'fresh',
      userInput: '结合链接整理 Phoenix 周报',
      sessionId: 'sess_round11',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async (input) => ({
        success: true,
        output: input.executionContextBundle?.materialContext.textSnippets?.map(item => item.content).join(' | ') ?? '',
        exitCode: 0,
        durationMs: 80,
      })),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn(),
      resolveIntent: vi.fn(),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;
    void llmBridge;
    void orchestration;
    void createConfig();

    const result = await executor.execute({
      task,
      preferences: [],
      userPrompt: '结合链接整理 Phoenix 周报',
      conversationHistory: [],
      executionContextBundle: bundle,
    });

    expect(result.output).toContain('Phoenix Weekly');
    expect(result.output).toContain('核心模块联调');
    expect(bundle.materialContext.summary?.status).toBe('ready');
  });
});
