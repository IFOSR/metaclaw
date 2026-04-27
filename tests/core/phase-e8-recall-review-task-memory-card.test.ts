import { describe, expect, it } from 'vitest';
import { RecallReviewBuilder } from '../../src/core/recall-review-builder.js';
import type { TaskMemoryCandidate } from '../../src/core/types.js';

function createTaskCandidate(overrides: Partial<TaskMemoryCandidate> = {}): TaskMemoryCandidate {
  return {
    id: 'tmc_resume_phoenix_weekly',
    taskId: 'task_phoenix_weekly_parked',
    sourceTaskId: 'task_phoenix_weekly_parked',
    memoryKind: 'task_summary',
    title: 'Phoenix 周报整理恢复',
    summary: '已完成风险栏目，剩余经营数据栏目需要补齐后输出周报。',
    reason: '恢复型召回：当前任务与历史卡片 taskId 相同',
    source: 'continuity',
    score: 96,
    artifactPaths: ['docs/phoenix-weekly-draft.md'],
    ...overrides,
  };
}

describe('Phase E8 RecallReviewBuilder task memory cards', () => {
  it('renders resume and reference task memory card candidates as distinct review items', () => {
    const card = new RecallReviewBuilder().build({
      preferenceCandidates: [],
      taskCandidates: [
        createTaskCandidate({
          id: 'tmc_resume_phoenix_weekly',
          taskId: 'task_phoenix_weekly_parked',
          sourceTaskId: 'task_phoenix_weekly_parked',
          reason: '恢复型召回：继续同一个未完成任务',
          source: 'continuity',
          score: 96,
        } as Partial<TaskMemoryCandidate>),
        createTaskCandidate({
          id: 'tmc_reference_phoenix_review',
          taskId: 'task_phoenix_review_done',
          sourceTaskId: 'task_phoenix_review_done',
          title: 'Phoenix 复盘报告',
          summary: '已沉淀风险、经营数据和结论三段式结构，可作为类似材料参考。',
          reason: '参考型召回：高相关成功任务卡片',
          source: 'continuity',
          score: 84,
          artifactPaths: ['docs/phoenix-review-output.md'],
        } as Partial<TaskMemoryCandidate>),
      ],
    });

    expect(card.taskMemorySummary.map(item => item.summary).join('\n')).toContain('恢复型召回');
    expect(card.taskMemorySummary.map(item => item.reason).join('\n')).toContain('继续同一个未完成任务');
    expect(card.taskMemorySummary.map(item => item.summary).join('\n')).toContain('参考型召回');
    expect(card.taskMemorySummary.map(item => item.reason).join('\n')).toContain('高相关成功任务卡片');
    expect(card.taskMemorySummary.map(item => item.label)).toEqual([
      'Phoenix 周报整理恢复',
      'Phoenix 复盘报告',
    ]);
  });
});
