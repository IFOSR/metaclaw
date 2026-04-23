import { describe, expect, it, vi } from 'vitest';
import { TaskEmbeddingService } from '../../src/core/task-embedding-service.js';
import { buildTaskMemoryDocuments } from '../../src/core/resume-context-builder.js';
import type { Task } from '../../src/core/types.js';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_1',
    title: 'Phoenix 周报整理',
    goal: '完成本周 Phoenix 周报',
    status: 'parked',
    summary: '已完成结构搭建，待补经营数据',
    snapshots: [{
      done: ['已整理风险栏目'],
      pending: ['待补经营数据'],
      nextStep: '补齐经营数据并汇总',
      pauseReason: '等待数据补齐',
      createdAt: '2026-04-20T00:00:00Z',
    }],
    resources: ['/tmp/phoenix-weekly.md'],
    artifacts: [],
    dependencies: [],
    prioritySignals: {
      dueAt: null,
      isReady: true,
      progressRatio: 0.7,
      blocksOthers: false,
      idleHours: 4,
    },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '等待经营数据',
    interruptionCount: 1,
    createdAt: '2026-04-19T00:00:00Z',
    updatedAt: '2026-04-20T00:00:00Z',
    ...overrides,
  };
}

describe('TaskEmbeddingService', () => {
  it('embeds task summary documents for semantic recall', async () => {
    const provider = {
      provider: 'test-provider',
      model: 'test-model',
      embed: vi.fn().mockResolvedValue([[0.9, 0.1]]),
    };
    const repo = {
      findBySource: vi.fn().mockReturnValue(null),
      upsert: vi.fn(),
    };

    const service = new TaskEmbeddingService(provider as any, repo as any);
    const stored = await service.embedTaskDocument({
      taskId: 'task_1',
      memoryKind: 'task_summary',
      sourceId: 'task_1',
      text: 'Phoenix 周报，已整理风险栏目，待补经营数据',
    });

    expect(stored).toBe(true);
    expect(provider.embed).toHaveBeenCalledWith(['Phoenix 周报，已整理风险栏目，待补经营数据']);
    expect(repo.upsert).toHaveBeenCalledTimes(1);
  });

  it('builds compact task memory documents instead of raw interaction dumps', () => {
    const task = createTask();

    const documents = buildTaskMemoryDocuments(task, {
      materialSummary: '共 1 份材料，可直接引用 Phoenix 周报正文',
    });

    expect(documents.map(document => document.memoryKind)).toEqual([
      'task_summary',
      'snapshot_summary',
      'material_summary',
    ]);
    expect(documents[0]?.text).toContain('任务标题：Phoenix 周报整理');
    expect(documents[0]?.text).toContain('任务目标：完成本周 Phoenix 周报');
    expect(documents[0]?.text).toContain('最新总结：已完成结构搭建，待补经营数据');
    expect(documents[1]?.text).toContain('已完成：已整理风险栏目');
    expect(documents[1]?.text).toContain('待处理：待补经营数据');
    expect(documents[2]?.text).toContain('材料摘要：共 1 份材料，可直接引用 Phoenix 周报正文');
    expect(JSON.stringify(documents)).not.toContain('systemOutput');
    expect(JSON.stringify(documents)).not.toContain('userInput');
  });
});
