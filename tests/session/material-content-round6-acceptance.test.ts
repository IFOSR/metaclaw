import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
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
import { ResumeContextBuilder } from '../../src/core/resume-context-builder.js';

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

describe('Round 6 material content acceptance', () => {
  it('injects attached text material content so the executor can see facts instead of only file paths', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const builder = new ResumeContextBuilder(taskEngine, memoryEngine, contextRecaller);

    const fixturesDir = resolve(tmpdir(), 'metaclaw-material-content-round6');
    mkdirSync(fixturesDir, { recursive: true });
    const weeklyPath = resolve(fixturesDir, 'phoenix-weekly.md');
    const riskPath = resolve(fixturesDir, 'risks.md');
    writeFileSync(weeklyPath, '本周完成 Phoenix 核心模块联调，主线推进稳定。', 'utf-8');
    writeFileSync(riskPath, '当前风险在跨团队依赖和测试数据准备不足。', 'utf-8');

    const task = taskEngine.create({
      title: 'Phoenix 周报整理',
      goal: '整理 Phoenix 周报',
      resources: [weeklyPath, riskPath],
    });

    const bundle = await builder.build({
      taskId: task.id,
      mode: 'fresh',
      userInput: '结合材料整理 Phoenix 周报结论',
      sessionId: 'sess_round6',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async (input) => ({
        success: true,
        output: `我看到了这些材料事实：${input.executionContextBundle?.materialContext.textSnippets.map(item => item.content).join(' | ')}`,
        exitCode: 0,
        durationMs: 100,
      })),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn(),
      resolveIntent: vi.fn(),
      rankInteractions: vi.fn(),
    } as unknown as LlmBridge;

    const result = await executor.execute({
      task,
      preferences: [],
      userPrompt: '结合材料整理 Phoenix 周报结论',
      conversationHistory: [],
      executionContextBundle: bundle,
    });

    expect(result.output).toContain('核心模块联调');
    expect(result.output).toContain('跨团队依赖');
  });
});
