import { describe, expect, it } from 'vitest';
import type { ConversationTurn } from '../../src/executor/adapter.js';

describe('ConversationTurn typing', () => {
  it('accepts llm as a valid recall source', () => {
    const turn: ConversationTurn = {
      taskId: 'task_1',
      userInput: '之前帮我比较的那两个项目',
      systemOutput: '对比分析完成',
      createdAt: '2026-04-15T00:00:00Z',
      source: 'llm',
    };

    expect(turn.source).toBe('llm');
  });

  it('accepts timeline as a valid recall source', () => {
    const turn: ConversationTurn = {
      taskId: 'task_1',
      userInput: '今天早上我让你执行了什么任务',
      systemOutput: '时间范围记录已召回',
      createdAt: '2026-05-06T02:45:00.000Z',
      source: 'timeline',
    };

    expect(turn.source).toBe('timeline');
  });
});
