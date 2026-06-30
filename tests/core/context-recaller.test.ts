import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { ContextRecaller } from '../../src/core/context-recaller.js';
import type { LlmBridge } from '../../src/core/llm-bridge.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertInteraction(db: Database.Database, opts: {
  id: string;
  taskId: string;
  sessionId?: string;
  userInput: string;
  systemOutput: string;
  createdAt: string;
}) {
  db.prepare(
    'INSERT INTO interactions (id, task_id, session_id, user_input, system_output, executor_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(opts.id, opts.taskId, opts.sessionId ?? null, opts.userInput, opts.systemOutput, 'claude-code', opts.createdAt);
}

describe('ContextRecaller', () => {
  let db: Database.Database;
  let recaller: ContextRecaller;

  beforeEach(() => {
    db = createTestDb();
    recaller = new ContextRecaller(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('第一层：召回当前任务历史', () => {
    insertInteraction(db, {
      id: 'int_1', taskId: 'task_A', sessionId: 'sess_1',
      userInput: '分析搜索引擎', systemOutput: '已完成分析',
      createdAt: '2026-04-12T10:00:00Z',
    });
    insertInteraction(db, {
      id: 'int_2', taskId: 'task_A', sessionId: 'sess_1',
      userInput: '继续深入', systemOutput: '深入分析完成',
      createdAt: '2026-04-12T10:01:00Z',
    });

    const result = recaller.recall({
      taskId: 'task_A', sessionId: 'sess_1', userInput: '总结一下',
    });

    const taskTurns = result.filter(t => t.source === 'task');
    expect(taskTurns).toHaveLength(2);
    expect(taskTurns[0].userInput).toBe('分析搜索引擎');
  });

  it('第二层：召回同会话跨任务历史', () => {
    insertInteraction(db, {
      id: 'int_1', taskId: 'task_A', sessionId: 'sess_1',
      userInput: '搜索引擎调研', systemOutput: '调研结果...',
      createdAt: '2026-04-12T10:00:00Z',
    });
    insertInteraction(db, {
      id: 'int_2', taskId: 'task_B', sessionId: 'sess_1',
      userInput: '你刚才说的搜索引擎', systemOutput: '关于搜索引擎...',
      createdAt: '2026-04-12T10:05:00Z',
    });

    const result = recaller.recall({
      taskId: 'task_B', sessionId: 'sess_1', userInput: '继续',
    });

    const sessionTurns = result.filter(t => t.source === 'session');
    expect(sessionTurns).toHaveLength(1);
    expect(sessionTurns[0].taskId).toBe('task_A');
  });

  it('第三层：关键词召回跨会话历史', () => {
    insertInteraction(db, {
      id: 'int_old', taskId: 'task_X', sessionId: 'sess_old',
      userInput: 'search engine for agents 调研', systemOutput: '调研结果...',
      createdAt: '2026-04-11T10:00:00Z',
    });

    const result = recaller.recall({
      taskId: 'task_new', sessionId: 'sess_new', userInput: '上次讨论的 search engine',
    });

    const keywordTurns = result.filter(t => t.source === 'keyword');
    expect(keywordTurns).toHaveLength(1);
    expect(keywordTurns[0].userInput).toContain('search engine');
  });

  it('去重：同一条记录不会出现在多层', () => {
    insertInteraction(db, {
      id: 'int_1', taskId: 'task_A', sessionId: 'sess_1',
      userInput: 'search engine 分析', systemOutput: '分析完成',
      createdAt: '2026-04-12T10:00:00Z',
    });

    // 这条记录同时满足第一层（task_A）和第三层（关键词 search engine）
    const result = recaller.recall({
      taskId: 'task_A', sessionId: 'sess_1', userInput: 'search engine 总结',
    });

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('task');
  });

  it('output 截断至 150 字符', () => {
    const longOutput = '这是一段很长的输出'.repeat(50);
    insertInteraction(db, {
      id: 'int_1', taskId: 'task_A', sessionId: 'sess_1',
      userInput: '测试', systemOutput: longOutput,
      createdAt: '2026-04-12T10:00:00Z',
    });

    const result = recaller.recall({
      taskId: 'task_A', sessionId: 'sess_1', userInput: '继续',
    });

    expect(result[0].systemOutput.length).toBeLessThanOrEqual(153); // 150 + '...'
    expect(result[0].systemOutput).toMatch(/\.\.\.$/);
  });

  it('当前任务历史上限 10 轮', () => {
    for (let i = 0; i < 15; i++) {
      insertInteraction(db, {
        id: `int_${i}`, taskId: 'task_A', sessionId: 'sess_1',
        userInput: `问题 ${i}`, systemOutput: `回答 ${i}`,
        createdAt: `2026-04-12T10:${String(i).padStart(2, '0')}:00Z`,
      });
    }

    const result = recaller.recall({
      taskId: 'task_A', sessionId: 'sess_1', userInput: '继续',
    });

    const taskTurns = result.filter(t => t.source === 'task');
    expect(taskTurns).toHaveLength(10);
  });

  it('无历史时返回空数组', () => {
    const result = recaller.recall({
      taskId: 'task_none', sessionId: 'sess_none', userInput: '你好',
    });
    expect(result).toHaveLength(0);
  });

  it('跨会话中文关键词召回：用户用不同措辞引用之前的任务', () => {
    insertInteraction(db, {
      id: 'int_old', taskId: 'task_X', sessionId: 'sess_old',
      userInput: '帮我做个调研，目前hermes-agent与openclaw这两个agent特别火',
      systemOutput: 'Hermes Agent 和 OpenClaw 的对比分析...',
      createdAt: '2026-04-12T10:00:00Z',
    });

    // 新会话，用户用不同措辞引用之前的调研
    const result = recaller.recall({
      taskId: 'task_new', sessionId: 'sess_new',
      userInput: '刚才让你做了一个产品调研，还记得不',
    });

    const keywordTurns = result.filter(t => t.source === 'keyword');
    expect(keywordTurns).toHaveLength(1);
    expect(keywordTurns[0].userInput).toContain('hermes-agent');
  });

  it('中文关键词提取应生成 bigram 片段', () => {
    insertInteraction(db, {
      id: 'int_1', taskId: 'task_A', sessionId: 'sess_1',
      userInput: '整理行业分析报告', systemOutput: '已完成',
      createdAt: '2026-04-12T10:00:00Z',
    });

    const result = recaller.recall({
      taskId: 'task_new', sessionId: 'sess_new',
      userInput: '之前那个行业分析做完了吗',
    });

    const keywordTurns = result.filter(t => t.source === 'keyword');
    expect(keywordTurns).toHaveLength(1);
  });

  it('召回止血：泛化短语不应通过中文 bigram 污染相似历史', () => {
    insertInteraction(db, {
      id: 'int_noise', taskId: 'task_noise', sessionId: 'sess_old',
      userInput: '帮我做个咖啡机选购调研，目前预算三千以内',
      systemOutput: '咖啡机历史输出不应进入 MetaClaw 优化任务',
      createdAt: '2026-04-12T10:00:00Z',
    });

    const result = recaller.recall({
      taskId: 'task_metaclaw', sessionId: 'sess_new',
      userInput: '刚才让你做了一个 MetaClaw 上下文召回优化，还记得不',
    });

    const keywordTurns = result.filter(t => t.source === 'keyword');
    expect(keywordTurns).toHaveLength(0);
  });

  it('召回止血：关键词相似历史默认最多只返回一条高相关参考', () => {
    for (let index = 0; index < 3; index += 1) {
      insertInteraction(db, {
        id: `int_meta_${index}`, taskId: `task_meta_${index}`, sessionId: 'sess_old',
        userInput: `MetaClaw 上下文召回优化方案第 ${index} 轮`,
        systemOutput: `MetaClaw 召回优化输出 ${index}`,
        createdAt: `2026-04-12T10:0${index}:00Z`,
      });
    }

    const result = recaller.recall({
      taskId: 'task_new', sessionId: 'sess_new',
      userInput: '继续 MetaClaw 上下文召回优化',
    });

    const keywordTurns = result.filter(t => t.source === 'keyword');
    expect(keywordTurns).toHaveLength(1);
    expect(keywordTurns[0].userInput).toContain('MetaClaw');
  });

  it('时间范围召回：今天早上的任务清单应按北京时间 created_at 查询', () => {
    insertInteraction(db, {
      id: 'int_yesterday_night', taskId: 'task_old', sessionId: 'sess_old',
      userInput: '昨天晚上帮我整理别的材料',
      systemOutput: '旧任务不应进入今天早上清单',
      createdAt: '2026-05-05T15:59:59.999Z',
    });
    insertInteraction(db, {
      id: 'int_palantir', taskId: 'task_dIaOBuCeIC', sessionId: 'sess_old',
      userInput: 'Palantir这家美股上市企业已经发布了财报了。根据最新的财报，做一个深度调研',
      systemOutput: 'Palantir 财报分析完成',
      createdAt: '2026-05-05T23:31:37.701Z',
    });
    insertInteraction(db, {
      id: 'int_yixunpan', taskId: 'task_WJVB367avd', sessionId: 'sess_1',
      userInput: '今天早上我让你做了一个公司的调研，具体是哪个公司？',
      systemOutput: '今天早上你让我调研的公司是：易寻盘',
      createdAt: '2026-05-06T02:43:09.481Z',
    });
    insertInteraction(db, {
      id: 'int_afternoon', taskId: 'task_late', sessionId: 'sess_old',
      userInput: '今天下午继续做渠道分析',
      systemOutput: '下午任务不应进入早上清单',
      createdAt: '2026-05-06T04:00:00.000Z',
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T03:00:00.000Z'));
    const result = recaller.recall({
      taskId: 'task_current',
      sessionId: 'sess_1',
      userInput: '今天早上我让你执行了什么任务，列出来今天早上执行的任务清单',
    });

    const timelineTurns = result.filter(t => t.source === 'timeline');
    expect(timelineTurns.map(t => t.taskId)).toEqual(['task_dIaOBuCeIC', 'task_WJVB367avd']);
    expect(timelineTurns[0].userInput).toContain('Palantir');
    expect(timelineTurns[1].userInput).toContain('具体是哪个公司');
  });

  it('LLM 排序：当 bigram 匹配不到时，用 LLM 召回', async () => {
    insertInteraction(db, {
      id: 'int_1', taskId: 'task_X', sessionId: 'sess_old',
      userInput: '帮我比较 hermes-agent 和 openclaw',
      systemOutput: '对比分析完成',
      createdAt: '2026-04-12T10:00:00Z',
    });

    // mock LlmBridge 返回匹配的 ID
    const mockBridge = {
      rankInteractions: vi.fn().mockResolvedValue(['int_1']),
    } as unknown as LlmBridge;

    const llmRecaller = new ContextRecaller(db, mockBridge);
    const result = await llmRecaller.recallAsync({
      taskId: 'task_new', sessionId: 'sess_new',
      userInput: '之前帮我比较的那两个开源项目',
    });

    const llmTurns = result.filter(t => t.source === 'llm');
    expect(llmTurns).toHaveLength(1);
    expect(llmTurns[0].userInput).toContain('hermes-agent');
    expect(mockBridge.rankInteractions).toHaveBeenCalled();
  });

  it('普通对话的模糊继续优先使用同会话最近上下文，不让 LLM 相似旧主题覆盖当前主题', async () => {
    insertInteraction(db, {
      id: 'int_recent_current',
      taskId: '',
      sessionId: 'sess_1',
      userInput: 'MetaClaw 调度任务时为什么要明确展示 Executor？',
      systemOutput: '我先讲两点：一是用户需要知道哪个 Executor 在处理；二是 MetaClaw 和 Executor 里程碑要分层展示。',
      createdAt: '2026-06-24T10:00:00Z',
    });
    insertInteraction(db, {
      id: 'int_old_helmet',
      taskId: 'task_helmet',
      sessionId: 'sess_old',
      userInput: '帮我调研 JUST1 头盔产品',
      systemOutput: 'JUST1 头盔调研报告。',
      createdAt: '2026-06-23T10:00:00Z',
    });

    const mockBridge = {
      rankInteractions: vi.fn().mockResolvedValue(['int_old_helmet']),
    } as unknown as LlmBridge;
    const llmRecaller = new ContextRecaller(db, mockBridge);

    const result = await llmRecaller.recallAsync({
      taskId: '',
      sessionId: 'sess_1',
      userInput: '这个问题你怎么回答了一半？继续完成。',
    });

    expect(result.map(turn => turn.userInput)).toContain('MetaClaw 调度任务时为什么要明确展示 Executor？');
    expect(result.map(turn => turn.userInput)).not.toContain('帮我调研 JUST1 头盔产品');
    expect(mockBridge.rankInteractions).not.toHaveBeenCalled();
  });

  it('LLM 排序失败时 fallback 到 bigram', async () => {
    insertInteraction(db, {
      id: 'int_1', taskId: 'task_X', sessionId: 'sess_old',
      userInput: '帮我做个调研，目前hermes-agent与openclaw',
      systemOutput: '调研完成',
      createdAt: '2026-04-12T10:00:00Z',
    });

    const mockBridge = {
      rankInteractions: vi.fn().mockRejectedValue(new Error('timeout')),
    } as unknown as LlmBridge;

    const llmRecaller = new ContextRecaller(db, mockBridge);
    const result = await llmRecaller.recallAsync({
      taskId: 'task_new', sessionId: 'sess_new',
      userInput: '刚才让你做了一个产品调研，还记得不',
    });

    // fallback 到 bigram，应该能通过"调研"匹配到
    const keywordTurns = result.filter(t => t.source === 'keyword');
    expect(keywordTurns).toHaveLength(1);
  });

  it('can recall only the interactions of accepted related tasks', () => {
    insertInteraction(db, {
      id: 'int_task_a_1', taskId: 'task_A', sessionId: 'sess_1',
      userInput: '整理 Phoenix 周报结构', systemOutput: '已生成结构草案',
      createdAt: '2026-04-12T10:00:00Z',
    });
    insertInteraction(db, {
      id: 'int_task_b_1', taskId: 'task_B', sessionId: 'sess_1',
      userInput: '补齐经营数据', systemOutput: '经营数据已补充',
      createdAt: '2026-04-12T10:01:00Z',
    });

    const result = recaller.recallForTaskIds(['task_B']);

    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe('task_B');
    expect(result[0].userInput).toContain('经营数据');
  });
});
