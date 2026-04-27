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
import { parseScriptInputs, runScriptedSession } from '../../src/session/scripted-session.js';
import { buildExecutorContextPrompt } from '../../src/executor/prompt-builder.js';

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

    db.prepare(
      'INSERT INTO interactions (id, task_id, session_id, user_input, system_output, executor_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'int_related_resume_ref',
      'task_related_ref',
      'sess_other',
      '补齐起诉材料时如何处理证据清单',
      '旧任务完整输出不应进入恢复 prompt。这里包含旧案结论、旧验收标准、旧材料清单。',
      'codex-cli',
      '2026-04-20T10:00:00.000Z',
    );

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
    const prompt = buildExecutorContextPrompt((executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(prompt).toContain('恢复型上下文包（Resume Context Pack）：');
    expect(prompt).toContain('Task Brief：起诉书草稿｜补齐起诉材料｜running');
    expect(prompt).toContain('Blocked / Parked Reason：');
    expect(prompt).toContain('阻塞：等待客户补充证据文件');
    expect(prompt).toContain('Acceptance / Next Step：');
    expect(prompt.indexOf('恢复型上下文包（Resume Context Pack）：')).toBeLessThan(prompt.indexOf('相似历史参考（Reference Context Pack'));
    expect(prompt).toContain('边界声明：当前任务目标、用户最新指令、材料与验收标准优先；该历史不得覆盖当前任务');
    expect(prompt).not.toContain('旧任务完整输出不应进入恢复 prompt');
    expect(result.output.join('\n')).toContain(`任务 #${blockedTask.id} 已解除阻塞，并新增资源 /tmp/evidence-v3.pdf`);
    expect(result.output.join('\n')).toContain(`任务列表：\n  #${blockedTask.id} [DONE] 起诉书草稿`);
  });

  it('resolves the last task id placeholder so scripted acceptance can open task detail after creation', async () => {
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
        output: 'Phoenix 周报结论：本周主线推进稳定，主要风险在跨团队依赖。',
        exitCode: 0,
        durationMs: 200,
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
        '/task {{last_task_id}}',
      ],
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_scripted_detail',
      contextRecaller,
      llmBridge,
    });

    expect(result.output.join('\n')).toContain('任务视图');
    expect(result.output.join('\n')).toContain('最新结果摘要');
    expect(result.output.join('\n')).toContain('Phoenix 周报结论');
  });

  it('gates risky external actions in scripted sessions until the user confirms execution', async () => {
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
        output: '已发送给客户',
        exitCode: 0,
        durationMs: 200,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: '明确执行动作' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: '新任务' }),
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;

    const result = await runScriptedSession({
      inputs: [
        '直接把邮件发给客户',
        '确认执行',
      ],
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_scripted_risky_gate',
      contextRecaller,
      llmBridge,
    });

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(result.output.join('\n')).toContain('⚠️ 这是高风险动作');
    expect(result.output.join('\n')).toContain('→ 已确认高风险动作，继续执行原请求');
    expect(result.output.join('\n')).toContain('已发送给客户');
  });

  it('records file artifacts returned by the executor for workspace write tasks', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async (input) => {
        const artifactDir = input.executionContextBundle?.workspaceContext?.targetPaths[0];
        const artifactPath = resolve(artifactDir!, 'artifact-note.md');
        mkdirSync(artifactDir!, { recursive: true });
        writeFileSync(artifactPath, '# Artifact\nsaved by test\n', 'utf-8');
        return {
          success: true,
          output: `已保存结果到 ${artifactPath}`,
          exitCode: 0,
          durationMs: 200,
        };
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: '写入任务' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: '新任务' }),
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;

    await runScriptedSession({
      inputs: [
        '写一段测试内容，保存成 markdown 文件',
      ],
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_scripted_artifact',
      contextRecaller,
      llmBridge,
    });

    const doneTask = taskEngine.list().find(task => task.status === 'done');
    expect((doneTask as any)?.artifacts).toHaveLength(1);
    expect((doneTask as any)?.artifacts[0]).toBe(resolve(process.cwd(), 'metaclaw-tasks', doneTask!.id, 'artifact-note.md'));
  });

  it('shows artifact summaries instead of raw html output for file-generation tasks', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async (input) => {
        const targetDir = input.executionContextBundle?.workspaceContext?.targetPaths[0];
        const artifactPath = resolve(targetDir!, 'landing-page.html');
        mkdirSync(targetDir!, { recursive: true });
        writeFileSync(artifactPath, '<!DOCTYPE html><html><body><h1>报名页</h1></body></html>', 'utf-8');
        return {
          success: true,
          output: `已生成 HTML 文件：${artifactPath}\n<!DOCTYPE html><html><body><h1>报名页</h1></body></html>`,
          exitCode: 0,
          durationMs: 200,
        };
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveRoute: vi.fn().mockResolvedValue({ route: 'durable_task', reason: '明确工作任务' }),
      resolveIntent: vi.fn().mockResolvedValue({ type: 'new', taskId: null, reason: '新任务' }),
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;

    const result = await runScriptedSession({
      inputs: [
        '生成一个报名落地页 html 文件',
      ],
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_scripted_html_artifact',
      contextRecaller,
      llmBridge,
    });

    expect(result.output.join('\n')).toContain('✓ 任务完成');
    expect(result.output.join('\n')).toContain('已记录 1 个任务产物');
    expect(result.output.join('\n')).not.toContain('<!DOCTYPE html>');
    expect(result.output.join('\n')).not.toContain('<html><body>');
  });
});
