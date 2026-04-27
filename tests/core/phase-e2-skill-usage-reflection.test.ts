import { describe, expect, it } from 'vitest';
import { ReflectionEngine } from '../../src/core/reflection-engine.js';
import type { SkillUsageEventRecord } from '../../src/storage/skill-usage-event-repo.js';

describe('ReflectionEngine skill usage learning', () => {
  it('turns completed skill usage events into pending learning candidates', () => {
    const engine = new ReflectionEngine();
    const event: SkillUsageEventRecord = {
      id: 'sue_1',
      taskId: 'task_1',
      executionId: 'exec_1',
      executorName: 'codex-cli',
      skillName: 'test-driven-development',
      skillVersion: '1.1.0',
      eventType: 'skill_completed',
      message: 'TDD 流程完成且测试通过',
      payload: { tests: 'passed' },
      createdAt: '2026-04-27T01:00:00Z',
    };

    const result = engine.reflectOnSkillUsage(event);

    expect(result.event).toMatchObject({
      sourceType: 'executor_skill_usage',
      sourceId: 'sue_1',
      taskId: 'task_1',
    });
    expect(result.candidate).toMatchObject({
      kind: 'skill',
      status: 'pending',
      sourceReflectionId: result.event.id,
      sourceTaskId: 'task_1',
      safetyStatus: 'passed',
    });
    expect(result.candidate?.title).toContain('test-driven-development');
    expect(result.candidate?.content).toContain('TDD 流程完成且测试通过');
  });

  it('turns failed skill usage events into workflow learning candidates without auto promotion', () => {
    const engine = new ReflectionEngine();
    const event: SkillUsageEventRecord = {
      id: 'sue_2',
      taskId: 'task_1',
      executionId: 'exec_1',
      executorName: 'codex-cli',
      skillName: 'debugging',
      skillVersion: null,
      eventType: 'skill_failed',
      message: '调试流程缺少日志采集步骤',
      payload: { missingSteps: ['读取完整错误'] },
      createdAt: '2026-04-27T01:05:00Z',
    };

    const result = engine.reflectOnSkillUsage(event);

    expect(result.candidate).toMatchObject({
      kind: 'workflow',
      status: 'pending',
      sourceTaskId: 'task_1',
    });
    expect(result.candidate?.title).toContain('debugging');
    expect(result.candidate?.content).toContain('调试流程缺少日志采集步骤');
  });
});
