import { describe, expect, it } from 'vitest';
import { ReflectionEngine } from '../../src/core/reflection-engine.js';

const createdAt = '2026-04-27T03:00:00Z';

describe('Phase E5 task memory card reflection', () => {
  it('creates a task_memory_card candidate for successful task completion without turning it into an executor skill', () => {
    const result = new ReflectionEngine().reflectOnTaskCompletion({
      taskId: 'task_e5_1',
      userInput: '实现 E5 Task Memory Card 和 Skill Effect Summary',
      executorOutput: [
        '完成内容：新增 task_memory_cards 与 skill_effect_summaries。',
        '关键决策：Task Memory Card 只记录任务事实，不写入 Preference。',
        '修改文件：src/storage/task-memory-card-repo.ts, src/storage/skill-effect-summary-repo.ts。',
        '验证命令：npm test -- tests/storage/phase-e5-learning-assets-storage.test.ts, npm run lint。',
        '坑点：summary 聚合要按 executor + skill + version。',
      ].join('\n'),
      success: true,
      createdAt,
    });

    expect(result.candidate).not.toBeNull();
    expect(result.candidate).toMatchObject({
      kind: 'task_memory_card',
      status: 'pending',
      sourceTaskId: 'task_e5_1',
      safetyStatus: 'passed',
      promotedAssetId: null,
    });
    expect(result.candidate?.title).toContain('任务记忆卡');
    expect(result.candidate?.content).toContain('Task Memory Card');
    expect(result.candidate?.content).toContain('验证命令');
  });

  it('does not create task memory cards for failed tasks', () => {
    const result = new ReflectionEngine().reflectOnTaskCompletion({
      taskId: 'task_e5_failed',
      userInput: '失败任务不沉淀为 Task Memory Card',
      executorOutput: '测试未通过，不能作为长期事实卡片。',
      success: false,
      createdAt,
    });

    expect(result.candidate).toBeNull();
  });
});
