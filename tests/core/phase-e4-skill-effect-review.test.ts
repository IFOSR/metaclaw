import { describe, expect, it } from 'vitest';
import { ReflectionEngine } from '../../src/core/reflection-engine.js';
import type { SkillUsageEventRecord } from '../../src/storage/skill-usage-event-repo.js';

function skillEvent(overrides: Partial<SkillUsageEventRecord> = {}): SkillUsageEventRecord {
  return {
    id: 'sue_e4_1',
    taskId: 'task_e4',
    executionId: 'exec_e4',
    executorName: 'codex-cli',
    skillName: 'systematic-debugging',
    skillVersion: '1.1.0',
    eventType: 'skill_suggested_patch',
    message: 'Skill 缺少“先读取完整错误再修复”的步骤，建议补充到 Pitfalls。',
    payload: {
      suggestedPatch: '新增步骤：遇到测试失败时先运行 targeted test 并读取完整错误，再修改代码。',
      targetSkill: 'systematic-debugging',
    },
    createdAt: '2026-04-27T02:00:00.000Z',
    ...overrides,
  };
}

describe('ReflectionEngine skill effect review', () => {
  it('turns skill_suggested_patch events into skill_patch candidates for review', () => {
    const result = new ReflectionEngine().reflectOnSkillUsage(skillEvent());

    expect(result.event).toMatchObject({
      sourceType: 'executor_skill_usage',
      sourceId: 'sue_e4_1',
      taskId: 'task_e4',
    });
    expect(result.candidate).toMatchObject({
      kind: 'skill_patch',
      status: 'pending',
      sourceTaskId: 'task_e4',
      safetyStatus: 'passed',
    });
    expect(result.candidate?.title).toContain('systematic-debugging');
    expect(result.candidate?.content).toContain('suggestedPatch');
    expect(result.candidate?.content).toContain('先运行 targeted test');
  });

  it('turns repeated skill failures with missing steps into antipattern candidates', () => {
    const result = new ReflectionEngine().reflectOnSkillUsage(skillEvent({
      id: 'sue_e4_2',
      eventType: 'skill_failed',
      message: '连续失败：跳过 RED 阶段导致后续返工',
      payload: {
        failureCount: 3,
        missingSteps: ['没有先写失败测试', '没有确认 RED'],
      },
    }));

    expect(result.candidate).toMatchObject({
      kind: 'antipattern',
      status: 'pending',
      sourceTaskId: 'task_e4',
    });
    expect(result.candidate?.title).toContain('systematic-debugging');
    expect(result.candidate?.content).toContain('跳过 RED 阶段');
    expect(result.candidate?.content).toContain('failureCount');
  });

  it('turns successful verification payloads into verification_recipe candidates', () => {
    const result = new ReflectionEngine().reflectOnSkillUsage(skillEvent({
      id: 'sue_e4_3',
      eventType: 'skill_completed',
      skillName: 'metaclaw-verification',
      message: 'targeted regression、lint、build、full test 全部通过',
      payload: {
        verificationCommands: [
          'npm test -- tests/core/phase-e2-skill-usage-reflection.test.ts',
          'npm run lint',
          'npm run build',
        ],
      },
    }));

    expect(result.candidate).toMatchObject({
      kind: 'verification_recipe',
      status: 'pending',
      sourceTaskId: 'task_e4',
    });
    expect(result.candidate?.content).toContain('verificationCommands');
    expect(result.candidate?.content).toContain('npm run build');
  });
});
