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
import type { NotificationService } from '../../src/notifications/types.js';

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

function createDurableRouteBridge(): LlmBridge {
  return {
    resolveRoute: vi.fn().mockResolvedValue({
      route: 'durable_task',
      reason: 'memory acceptance task',
    }),
    resolveIntent: vi.fn().mockResolvedValue({
      type: 'new',
      taskId: null,
      reason: 'new task',
    }),
    rankInteractions: vi.fn().mockResolvedValue([]),
  } as unknown as LlmBridge;
}

describe('Round 1 memory acceptance', () => {
  it('supports three-hit confirm and contact recall in a follow-up task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const observationRepo = new ObservationRepo(db);
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), observationRepo);
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '邮件草稿已生成',
        exitCode: 0,
        durationMs: 120,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_memory_round1_confirm',
      contextRecaller,
      llmBridge: createDurableRouteBridge(),
    });

    session.initialize();
    await session.submit('给张总写一封邮件，内容是汇报本周进展，用正式语气', { awaitAsyncWork: true });
    await session.submit('再给张总写一封邮件，内容是同步项目风险，用正式语气', { awaitAsyncWork: true });
    await session.submit('继续给张总准备一封邮件，内容是安排下周会议，用正式语气', { awaitAsyncWork: true });

    const candidates = memoryEngine.getCandidates();
    expect(candidates).toHaveLength(1);
    expect(session.getSnapshot().output.join('\n')).toContain('检测到重复模式');

    await session.submit(`/memory confirm ${candidates[0].id} --scope contact --subject 张总`, { awaitAsyncWork: true });
    await session.submit('给张总再起草一封邮件，内容是提醒确认预算');

    const reviewOutput = session.getSnapshot().output.join('\n');
    expect(reviewOutput).toContain('记忆召回确认');
    expect(reviewOutput).toContain('[contact] 用正式语气');

    await session.submit('y', { awaitAsyncWork: true });

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('已确认偏好');
    expect(output).toContain('→ 已注入 1 条偏好');
    expect(output).toContain('[contact] 用正式语气');
    expect(output).toContain('confidence=');
    expect(output).toContain('命中主体：张总');
  });

  it('applies explicit input, then project/contact, then global memory in a project task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    memoryEngine.addManual({
      content: '输出尽量简洁',
      scope: 'global',
      type: 'style',
    });
    memoryEngine.addManual({
      content: 'Phoenix 项目材料统一使用 Phoenix 术语',
      scope: 'project',
      type: 'domain',
      subject: 'Phoenix',
    });
    memoryEngine.addManual({
      content: '给张总的邮件使用正式语气',
      scope: 'contact',
      type: 'contact',
      subject: '张总',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '项目周报已整理',
        exitCode: 0,
        durationMs: 100,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_memory_round1_precedence',
      contextRecaller,
      llmBridge: createDurableRouteBridge(),
    });

    session.initialize();
    await session.submit('给张总整理一份 Phoenix 项目周报，今天明确要求先保留表格格式');

    const reviewOutput = session.getSnapshot().output.join('\n');
    expect(reviewOutput).toContain('记忆召回确认');
    expect(reviewOutput).toContain('Phoenix 项目材料统一使用 Phoenix 术语');
    expect(reviewOutput).toContain('给张总的邮件使用正式语气');
    expect(reviewOutput).not.toContain('输出尽量简洁');

    await session.submit('y', { awaitAsyncWork: true });

    const executionInput = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const resolvedPreferences = executionInput.executionContextBundle.memoryContext.resolvedPreferences;

    expect(resolvedPreferences.map((preference: { id: string }) => preference.id)).toEqual([
      expect.any(String),
      expect.any(String),
    ]);
    expect(resolvedPreferences[0].scope).toBe('project');
    expect(resolvedPreferences[1].scope).toBe('contact');

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('今天明确要求先保留表格格式');
    expect(output.indexOf('[project] Phoenix 项目材料统一使用 Phoenix 术语')).toBeLessThan(
      output.indexOf('[contact] 给张总的邮件使用正式语气'),
    );
    expect(output).not.toContain('[global] 输出尽量简洁');
  });

  it('supports inline y confirmation for a pending preference candidate', async () => {
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
        output: '邮件草稿已生成',
        exitCode: 0,
        durationMs: 120,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_memory_round1_inline_confirm',
      contextRecaller,
      llmBridge: createDurableRouteBridge(),
    });

    session.initialize();
    await session.submit('给张总写一封邮件，内容是汇报本周进展，用正式语气', { awaitAsyncWork: true });
    await session.submit('再给张总写一封邮件，内容是同步项目风险，用正式语气', { awaitAsyncWork: true });
    await session.submit('继续给张总准备一封邮件，内容是安排下周会议，用正式语气', { awaitAsyncWork: true });

    const executorCallsBeforeConfirm = (executor.execute as ReturnType<typeof vi.fn>).mock.calls.length;
    await session.submit('y', { awaitAsyncWork: true });

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('[y] 确认');
    expect(output).toContain('[n] 忽略');
    expect(output).toContain('[e <新内容>] 编辑后确认');
    expect(output).toContain('已确认偏好');
    expect(memoryEngine.list({ status: 'confirmed' })).toHaveLength(1);
    expect((executor.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(executorCallsBeforeConfirm);
  });

  it('supports editing a pending preference candidate before confirmation', async () => {
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
        output: '邮件草稿已生成',
        exitCode: 0,
        durationMs: 120,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_memory_round1_inline_edit',
      contextRecaller,
      llmBridge: createDurableRouteBridge(),
    });

    session.initialize();
    await session.submit('给张总写一封邮件，内容是汇报本周进展，用正式语气', { awaitAsyncWork: true });
    await session.submit('再给张总写一封邮件，内容是同步项目风险，用正式语气', { awaitAsyncWork: true });
    await session.submit('继续给张总准备一封邮件，内容是安排下周会议，用正式语气', { awaitAsyncWork: true });
    await session.submit('e 给张总的邮件使用非常正式语气', { awaitAsyncWork: true });

    const prefs = memoryEngine.list({ status: 'confirmed' });
    expect(prefs).toHaveLength(1);
    expect(prefs[0]?.content).toBe('给张总的邮件使用非常正式语气');
    expect(session.getSnapshot().output.join('\n')).toContain('已编辑并确认偏好');
  });

  it('auto-captures a single high-confidence low-risk user preference statement', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const notifier: NotificationService = {
      notifyMemoryCandidate: vi.fn().mockResolvedValue(undefined),
    };

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '已记录偏好候选',
        exitCode: 0,
        durationMs: 120,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_memory_high_confidence_user_statement',
      contextRecaller,
      llmBridge: createDurableRouteBridge(),
      notifier,
    });

    session.initialize();
    await session.submit('以后凡是长篇调研、人物研究、竞品分析，默认输出 Markdown 文件，并在聊天中只给摘要和文件路径', { awaitAsyncWork: true });

    const candidates = memoryEngine.getCandidates();
    expect(candidates).toHaveLength(0);
    expect(memoryEngine.list({ status: 'confirmed' }).map(preference => preference.content)).toContain(
      '凡是长篇调研、人物研究、竞品分析，默认输出 Markdown 文件，并在聊天中只给摘要和文件路径',
    );
    expect(session.getSnapshot().output.join('\n')).toContain('已自动记录偏好');
    expect(notifier.notifyMemoryCandidate).not.toHaveBeenCalled();
  });

  it('creates a pending memory candidate when executor output identifies an explicit reusable work rule', async () => {
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
        output: [
          '基于当前注入的近期上下文，我能提炼出几条“可沿用的工作记忆”：',
          '你明确偏好：**长篇调研型输出应该保存成本地 Markdown 文件**，不要只放在聊天里。',
          '凡是长篇调研、人物研究、竞品分析、资料汇总，默认输出 Markdown 文件，并在聊天中只给摘要和文件路径。',
        ].join('\n'),
        exitCode: 0,
        durationMs: 120,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_memory_high_confidence_executor_statement',
      contextRecaller,
      llmBridge: createDurableRouteBridge(),
    });

    session.initialize();
    await session.submit('刚才基于上下文你能提炼出什么工作记忆？', { awaitAsyncWork: true });

    const candidates = memoryEngine.getCandidates();
    expect(candidates.map(candidate => candidate.pattern)).toContain('长篇调研型输出应该保存成本地 Markdown 文件');
    expect(session.getSnapshot().output.join('\n')).toContain('检测到可能的长期偏好');
    expect(memoryEngine.list({ status: 'confirmed' })).toHaveLength(0);
  });

  it('auto-captures explicit low-risk long-term preferences without confirmation', async () => {
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
        output: 'noop',
        exitCode: 0,
        durationMs: 10,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_memory_auto_capture_low_risk',
      contextRecaller,
      llmBridge: createDurableRouteBridge(),
    });

    session.initialize();
    await session.submit('以后凡是复杂方案，默认先给结论，再列执行细节');

    const confirmed = memoryEngine.list({ status: 'confirmed' });
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].content).toBe('凡是复杂方案，默认先给结论，再列执行细节');
    expect(memoryEngine.getCandidates()).toHaveLength(0);

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('已自动记录偏好');
    expect(output).not.toContain('要把它记为长期偏好吗');

    await session.submit('/memory auto-captured');
    expect(session.getSnapshot().output.join('\n')).toContain('自动写入记忆');
    expect(session.getSnapshot().output.join('\n')).toContain(confirmed[0].id);
  });

  it('does not silently auto-capture high-risk memory candidates', async () => {
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
        output: 'noop',
        exitCode: 0,
        durationMs: 10,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_memory_auto_capture_high_risk',
      contextRecaller,
      llmBridge: createDurableRouteBridge(),
    });

    session.initialize();
    await session.submit('以后凡是报告都要自动发给客户');

    expect(memoryEngine.list({ status: 'confirmed' })).toHaveLength(0);
    expect(memoryEngine.getCandidates()).toHaveLength(1);

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('高风险偏好不会静默写入');
  });
});
