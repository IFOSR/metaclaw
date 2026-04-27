import { describe, expect, it } from 'vitest';
import { TaskRelevanceRanker } from '../../src/core/task-relevance-ranker.js';
import type { Task } from '../../src/core/types.js';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_candidate',
    title: 'Phoenix 周报整理',
    goal: '整理 Phoenix 项目周报并保留风险栏目',
    status: 'done',
    summary: '完成 Phoenix 周报，包含风险栏目和经营数据栏目',
    snapshots: [{
      done: ['整理风险栏目', '整理经营数据'],
      pending: [],
      nextStep: '复用周报结构',
      pauseReason: '已完成',
      createdAt: '2026-04-20T00:00:00Z',
    }],
    resources: ['/tmp/phoenix-weekly.md'],
    artifacts: ['/tmp/phoenix-weekly-output.md'],
    dependencies: [],
    prioritySignals: {
      dueAt: null,
      isReady: true,
      progressRatio: 1,
      blocksOthers: false,
      idleHours: 2,
    },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: '2026-04-19T00:00:00Z',
    updatedAt: '2026-04-20T00:00:00Z',
    ...overrides,
  };
}

describe('TaskRelevanceRanker', () => {
  it('scores high-confidence reusable task candidates with reasons and no risk flags', () => {
    const ranker = new TaskRelevanceRanker();
    const result = ranker.rank({
      currentTask: createTask({
        id: 'task_current',
        title: '本周 Phoenix 周报',
        goal: '整理本周 Phoenix 项目周报，沿用风险栏目和经营数据栏目',
        createdAt: '2026-04-21T00:00:00Z',
        updatedAt: '2026-04-21T00:00:00Z',
      }),
      userInput: '继续整理 Phoenix 周报，复用上次风险栏目结构',
      keywords: ['Phoenix', '周报', '风险栏目'],
      candidates: [createTask()],
      now: new Date('2026-04-22T00:00:00Z'),
    });

    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe('task_candidate');
    expect(result[0].finalScore).toBeGreaterThanOrEqual(80);
    expect(result[0].recommendation).toBe('inject');
    expect(result[0].riskFlags).toEqual([]);
    expect(result[0].reason).toContain('共享关键词');
    expect(result[0].reason).toContain('存在可参考产物');
  });

  it('hard-filters unrelated cancelled or blocked tasks without explicit user reference', () => {
    const ranker = new TaskRelevanceRanker();
    const result = ranker.rank({
      currentTask: createTask({
        id: 'task_current',
        title: 'Phoenix 周报',
        goal: '整理本周 Phoenix 周报',
      }),
      userInput: '继续整理 Phoenix 周报',
      keywords: ['Phoenix', '周报'],
      candidates: [
        createTask({
          id: 'task_cancelled_unrelated',
          title: '合同纠纷起诉书',
          goal: '处理合同纠纷起诉材料',
          status: 'cancelled',
          summary: '已取消的法律任务',
          artifacts: [],
          resources: [],
        }),
        createTask({
          id: 'task_blocked_unrelated',
          title: '旧广告投放复盘',
          goal: '复盘广告素材和投放数据',
          status: 'blocked',
          summary: '阻塞中且未解决',
          artifacts: [],
          resources: [],
        }),
      ],
      now: new Date('2026-04-22T00:00:00Z'),
    });

    expect(result.map(item => item.taskId)).toEqual([]);
  });

  it('keeps medium-confidence candidates for review and exposes risk flags', () => {
    const ranker = new TaskRelevanceRanker();
    const result = ranker.rank({
      currentTask: createTask({
        id: 'task_current',
        title: 'Phoenix 周报',
        goal: '整理 Phoenix 周报',
      }),
      userInput: '参考 Phoenix 的历史材料，但不要直接套旧结论',
      keywords: ['Phoenix'],
      candidates: [createTask({
        id: 'task_old_partial',
        title: 'Phoenix 路线图讨论',
        goal: '讨论 Phoenix 产品路线图',
        summary: '只有项目主体相同，意图不同',
        artifacts: [],
        resources: [],
        updatedAt: '2026-01-01T00:00:00Z',
      })],
      now: new Date('2026-04-22T00:00:00Z'),
    });

    expect(result).toHaveLength(1);
    expect(result[0].recommendation).toBe('review');
    expect(result[0].finalScore).toBeGreaterThanOrEqual(65);
    expect(result[0].finalScore).toBeLessThan(80);
    expect(result[0].riskFlags).toContain('no_artifacts');
    expect(result[0].riskFlags).toContain('stale_candidate');
  });
});
