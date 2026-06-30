import { nanoid } from 'nanoid';
import type { LearningCandidateKind, LearningCandidateRecord } from '../storage/learning-candidate-repo.js';
import type { ReflectionEventRecord } from '../storage/reflection-event-repo.js';
import type { SkillUsageEventRecord } from '../storage/skill-usage-event-repo.js';
import { SafetyScanner } from './safety-scanner.js';

export interface TaskCompletionReflectionInput {
  taskId: string;
  userInput: string;
  executorOutput: string;
  success: boolean;
  createdAt: string;
}

export interface TaskCompletionReflectionResult {
  event: ReflectionEventRecord;
  candidate: LearningCandidateRecord | null;
}

export class ReflectionEngine {
  constructor(private readonly safetyScanner: SafetyScanner = new SafetyScanner()) {}

  reflectOnTaskCompletion(input: TaskCompletionReflectionInput): TaskCompletionReflectionResult {
    const event: ReflectionEventRecord = {
      id: `refl_${nanoid(10)}`,
      sourceType: 'task_completion',
      sourceId: input.taskId,
      taskId: input.taskId,
      summary: `${input.success ? '成功完成' : '执行失败'}：${input.userInput}`,
      evidence: {
        userInput: input.userInput,
        success: input.success,
        outputSnippet: input.executorOutput.slice(0, 500),
      },
      createdAt: input.createdAt,
    };

    if (!input.success) {
      return { event, candidate: null };
    }

    const rawContent = [
      'Task Memory Card',
      `任务：${input.userInput}`,
      `目标：${input.userInput}`,
      '摘要：任务已成功完成，可作为后续类似任务的事实参考。',
      `执行摘要：${input.executorOutput}`,
      '关键决策：从执行输出中复盘，用户审核后再落库。',
      '验证命令：见执行摘要中的测试/检查命令。',
      '结果：success',
    ].join('\n');
    const safety = this.safetyScanner.scanCandidate({
      title: `任务记忆卡：${input.userInput}`,
      content: rawContent,
    });

    const candidate: LearningCandidateRecord = {
      id: `lc_${nanoid(10)}`,
      kind: 'task_memory_card',
      status: 'pending',
      title: `任务记忆卡：${input.userInput}`,
      content: safety.redactedContent,
      sourceReflectionId: event.id,
      sourceTaskId: input.taskId,
      safetyStatus: safety.status,
      safetyReasons: safety.reasons,
      reviewNote: null,
      promotedAssetId: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };

    return { event, candidate };
  }

  reflectOnSkillUsage(input: SkillUsageEventRecord): TaskCompletionReflectionResult {
    const isFailure = input.eventType === 'skill_failed';
    const candidateKind = this.classifySkillUsageCandidate(input);
    const event: ReflectionEventRecord = {
      id: `refl_${nanoid(10)}`,
      sourceType: 'executor_skill_usage',
      sourceId: input.id,
      taskId: input.taskId,
      summary: `${isFailure ? 'Skill 使用失败' : 'Skill 使用完成'}：${input.skillName}`,
      evidence: {
        executionId: input.executionId,
        executorName: input.executorName,
        skillName: input.skillName,
        skillVersion: input.skillVersion,
        eventType: input.eventType,
        message: input.message,
        payload: input.payload,
      },
      createdAt: input.createdAt,
    };

    const title = this.buildSkillUsageCandidateTitle(input, candidateKind);
    const rawContent = [
      `Executor「${input.executorName}」使用 Skill「${input.skillName}」。`,
      `事件：${input.eventType}`,
      `结果：${input.message}`,
      `上下文：${JSON.stringify(input.payload)}`,
    ].join('\n');
    const safety = this.safetyScanner.scanCandidate({ title, content: rawContent });

    const candidate: LearningCandidateRecord = {
      id: `lc_${nanoid(10)}`,
      kind: candidateKind,
      status: 'pending',
      title,
      content: safety.redactedContent,
      sourceReflectionId: event.id,
      sourceTaskId: input.taskId,
      safetyStatus: safety.status,
      safetyReasons: safety.reasons,
      reviewNote: null,
      promotedAssetId: candidateKind === 'skill_patch' ? input.skillName : null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };

    return { event, candidate };
  }

  private classifySkillUsageCandidate(input: SkillUsageEventRecord): LearningCandidateKind {
    if (input.eventType === 'skill_suggested_patch') {
      return 'skill_patch';
    }

    if (input.eventType === 'skill_failed') {
      const failureCount = typeof input.payload?.failureCount === 'number' ? input.payload.failureCount : 1;
      return failureCount >= 2 ? 'antipattern' : 'workflow';
    }

    if (input.eventType === 'skill_completed' && Array.isArray(input.payload?.verificationCommands)) {
      return 'verification_recipe';
    }

    return 'skill';
  }

  private buildSkillUsageCandidateTitle(input: SkillUsageEventRecord, kind: LearningCandidateKind): string {
    switch (kind) {
      case 'skill_patch':
        return `Skill Patch 候选：${input.skillName}`;
      case 'antipattern':
        return `Skill 反模式：${input.skillName}`;
      case 'verification_recipe':
        return `验收配方：${input.skillName}`;
      case 'workflow':
        return `Skill 失败经验：${input.skillName}`;
      default:
        return `Skill 使用经验：${input.skillName}`;
    }
  }
}
