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
import { parseScriptInputs, runScriptedSession } from '../../src/session/scripted-session.js';

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

describe('scripted session', () => {
  it('parses script lines while ignoring comments and blank lines', () => {
    const script = `
# comment

帮我整理合同风险
  /tasks done

`;

    expect(parseScriptInputs(script)).toEqual([
      '帮我整理合同风险',
      '/tasks done',
    ]);
  });

  it('runs a blocked-task resume flow from scripted inputs', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const blockedTask = taskEngine.create({ title: '起诉书草稿', goal: '补齐起诉材料' });
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '等待客户补充证据文件',
      status: 'waiting',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '已恢复处理',
        exitCode: 0,
        durationMs: 500,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveIntent: vi.fn().mockResolvedValue({
        type: 'new',
        taskId: null,
        reason: '脚本输入',
      }),
    } as unknown as LlmBridge;

    const result = await runScriptedSession({
      inputs: [
        `/task ${blockedTask.id} unblock /tmp/evidence-v3.pdf`,
        '/tasks done',
      ],
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_scripted',
      contextRecaller,
      llmBridge,
    });

    expect(executor.execute).toHaveBeenCalled();
    const executionBundle = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0].executionContextBundle;
    expect(executionBundle.mode).toBe('resume-blocked');
    expect(executionBundle.resumeContext.blockedReason).toBe('等待客户补充证据文件');
    expect(executionBundle.materialContext.resources).toContain('/tmp/evidence-v3.pdf');
    expect(result.output.join('\n')).toContain(`任务 #${blockedTask.id} 已解除阻塞，并新增资源 /tmp/evidence-v3.pdf`);
    expect(result.output.join('\n')).toContain(`任务列表：\n  #${blockedTask.id} [DONE] 起诉书草稿`);
  });
});
