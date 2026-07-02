import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  AggregationVerifier,
  ArtifactVerifier,
  HeuristicVerifier,
  LlmVerifier,
  TestEvidenceVerifier,
  VerificationAndDeliveryService,
  extractConciseExecutorSummary,
} from '../../src/delivery/verification-and-delivery-service.js';
import type { AggregationPlan, ExecutionSubtask } from '../../src/core/execution-strategy-planner.js';
import type { SubtaskResult } from '../../src/execution/multi-executor-orchestrator.js';

function createAggregationSubtask(overrides: Partial<ExecutionSubtask>): ExecutionSubtask {
  return {
    id: 'subtask_test',
    title: 'Test unit',
    goal: 'Test goal',
    executorHint: 'codex-cli',
    dependsOn: [],
    inputs: { taskId: 'task_agg', resources: [], recalledTaskIds: [] },
    expectedOutput: 'summary',
    acceptance: [],
    riskLevel: 'low',
    ...overrides,
  };
}

function createAggregationPlan(): AggregationPlan {
  return {
    mode: 'verify_and_summarize',
    acceptance: [],
    conflictPolicy: 'flag_conflicts',
  };
}

describe('VerificationAndDeliveryService', () => {
  it('blocks undeliverable executor output with heuristic verification', () => {
    const result = new HeuristicVerifier().verify({
      output: 'Timeout — denying command because the workflow is waiting',
    });

    expect(result).toEqual({
      status: 'blocked',
      reason: '执行器返回未完成说明，未生成最终产物',
    });
  });

  it('runs verifier pipeline and blocks on the first verifier concern', () => {
    const service = new VerificationAndDeliveryService([
      new HeuristicVerifier(),
      new TestEvidenceVerifier(),
    ]);

    const result = service.prepare({
      output: '已修改仓库代码，但没有测试说明',
      durationMs: 1200,
      userPrompt: '修复 TypeScript bug',
      preferences: [],
      nextStep: '无后续建议',
      acceptanceCriteria: [{
        id: 'repo_execution_verified',
        description: '仓库修改任务必须提供测试结果，或说明未运行测试原因',
        requiredEvidence: ['测试命令', '测试结果', '未运行测试原因'],
        severity: 'must',
        appliesToSubtaskIds: [],
      }],
    });

    expect(result.verification).toEqual({
      status: 'blocked',
      reason: '缺少仓库修改任务的测试证据或未测试说明',
    });
    expect(result.artifactPaths).toEqual([]);
    expect(result.completionLines).toEqual([]);
  });

  it('accepts skill usage completion events as test evidence when payload reports passed tests', () => {
    const result = new VerificationAndDeliveryService([
      new TestEvidenceVerifier(),
    ]).prepare({
      output: '完成',
      evidenceText: [
        'skill_event=skill_completed skill=test-driven-development message=TDD 流程完成 payload={"tests":"passed"}',
      ],
      durationMs: 1200,
      userPrompt: '用 TDD 实现一个小功能',
      preferences: [],
      nextStep: '无后续建议',
      acceptanceCriteria: [{
        id: 'repo_execution_verified',
        description: '仓库修改任务必须提供测试结果，或说明未运行测试原因',
        requiredEvidence: ['测试命令', '测试结果', '未运行测试原因'],
        severity: 'must',
        appliesToSubtaskIds: [],
      }],
    });

    expect(result.verification).toEqual({ status: 'pass', reason: null });
  });

  it('verifies artifact evidence after extraction', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'metaclaw-artifact-verifier-'));
    const artifactPath = resolve(dir, 'result.md');
    writeFileSync(artifactPath, '# done\n', 'utf-8');

    const result = new VerificationAndDeliveryService([
      new ArtifactVerifier(),
    ]).prepare({
      output: `已生成 ${artifactPath}`,
      durationMs: 1200,
      userPrompt: '生成报告文件',
      workspaceContext: {
        allowFilesystem: true,
        workingDirectory: dir,
        targetPaths: [dir],
      },
      preferences: [],
      nextStep: '无后续建议',
      acceptanceCriteria: [{
        id: 'artifact_delivered',
        description: '必须产出可访问 artifact',
        requiredEvidence: ['artifact path'],
        severity: 'must',
        appliesToSubtaskIds: [],
      }],
    });

    expect(result.verification.status).toBe('pass');
    expect(result.artifactPaths).toContain(artifactPath);
  });

  it('does not require a filesystem artifact for generic user request satisfaction criteria', () => {
    const result = new VerificationAndDeliveryService([
      new ArtifactVerifier(),
    ]).prepare({
      output: '检查完成：文档内容完整。',
      durationMs: 1200,
      userPrompt: '检查这个任务生成的 Markdown 文档内容是否完整',
      preferences: [],
      nextStep: '无后续建议',
      acceptanceCriteria: [{
        id: 'user_request_satisfied',
        description: '最终结果必须回应用户原始需求',
        requiredEvidence: ['最终输出或产物说明'],
        severity: 'must',
        appliesToSubtaskIds: [],
      }],
    });

    expect(result.verification.status).toBe('pass');
  });

  it('accepts inline final content when artifact criteria allow either file path or final content', () => {
    const result = new VerificationAndDeliveryService([
      new ArtifactVerifier(),
    ]).prepare({
      output: '邮件草稿已生成：张总您好，本周项目进展如下...',
      durationMs: 1200,
      userPrompt: '给张总写一封邮件，内容是同步项目风险',
      preferences: [],
      nextStep: '无后续建议',
      acceptanceCriteria: [{
        id: 'artifact_delivered',
        description: '文档、报告或其他产物必须返回可定位的文件路径或完整最终内容',
        requiredEvidence: ['文件路径', '最终内容'],
        severity: 'must',
        appliesToSubtaskIds: [],
      }],
    });

    expect(result.verification.status).toBe('pass');
  });

  it('supports an LLM verifier adapter without making it mandatory', async () => {
    const verifier = new LlmVerifier(async input => ({
      status: input.output.includes('验收通过') ? 'pass' : 'blocked',
      reason: input.output.includes('验收通过') ? null : 'LLM verifier blocked',
    }));

    await expect(verifier.verify({
      output: '验收通过',
      acceptanceCriteria: [],
      artifactPaths: [],
    })).resolves.toEqual({ status: 'pass', reason: null });
  });

  it('adapts ExecutionAggregator into the verifier pipeline for multi-executor hard errors', () => {
    const result = new VerificationAndDeliveryService([
      new AggregationVerifier(),
    ]).prepare({
      output: 'multi executor output',
      durationMs: 1200,
      userPrompt: '执行复杂任务',
      preferences: [],
      nextStep: '无后续建议',
      aggregationVerification: {
        subtasks: [createAggregationSubtask({ id: 'subtask_missing', expectedOutput: 'review' })],
        results: [],
        aggregation: createAggregationPlan(),
      },
    });

    expect(result.verification).toEqual({
      status: 'blocked',
      reason: 'multi-executor aggregation verification failed: 缺少 subtask 执行结果',
    });
  });

  it('does not hard-block delivery for aggregation warnings that are retry feedback concerns', () => {
    const result = new AggregationVerifier().verify({
      output: 'multi executor output',
      acceptanceCriteria: [],
      artifactPaths: [],
      aggregationVerification: {
        subtasks: [createAggregationSubtask({ id: 'subtask_patch', expectedOutput: 'patch' })],
        results: [{
          subtaskId: 'subtask_patch',
          executorName: 'codex-cli',
          status: 'success',
          output: 'Changed src/core/foo.ts.',
          artifacts: [],
          startedAt: '2026-06-22T00:00:00.000Z',
          finishedAt: '2026-06-22T00:00:01.000Z',
        } satisfies SubtaskResult],
        aggregation: createAggregationPlan(),
      },
    });

    expect(result).toEqual({ status: 'pass', reason: null });
  });

  it('collects artifacts, writes Feishu fallback markdown, and builds completion lines', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'metaclaw-delivery-'));
    const artifactPath = resolve(dir, 'result.html');
    writeFileSync(artifactPath, '<html>done</html>', 'utf-8');

    const result = new VerificationAndDeliveryService().prepare({
      output: `已生成在线预览 ${artifactPath}`,
      durationMs: 1200,
      userPrompt: '生成飞书云文档和在线预览',
      workspaceContext: {
        allowFilesystem: true,
        workingDirectory: dir,
        targetPaths: [dir],
      },
      preferences: [],
      nextStep: '无后续建议',
    });

    const feishuFallbackPath = resolve(dir, 'feishu-document.md');
    expect(result.verification.status).toBe('pass');
    expect(result.artifactPaths).toEqual(expect.arrayContaining([artifactPath, feishuFallbackPath]));
    expect(existsSync(feishuFallbackPath)).toBe(true);
    expect(readFileSync(feishuFallbackPath, 'utf-8')).toContain('已生成在线预览');
    expect(result.completionLines.join('\n')).toContain('✓ 任务完成 (1.2s)');
    expect(result.completionLines.join('\n')).toContain('→ 已记录 2 个任务产物');
  });

  it('does not use an empty quoted file path as a concise summary', () => {
    const summary = extractConciseExecutorSummary(
      '已创建文件：``\n保存路径：/tmp/metaclaw-output/smoke-result.md',
      ['/tmp/metaclaw-output/smoke-result.md'],
    );

    expect(summary).toBeNull();
  });

  it('delivers resume-blocked task completion through notification service only when needed', async () => {
    const notifier = {
      notifyMemoryCandidate: vi.fn(),
      notifyTaskCompleted: vi.fn().mockResolvedValue(undefined),
    };
    const service = new VerificationAndDeliveryService();

    expect(await service.deliverTaskCompletion(notifier, {
      taskId: 'task_done',
      title: 'Done',
      summary: 'summary',
      output: 'output',
      artifactPaths: [],
      durationMs: 100,
      executionMode: 'fresh',
      origin: 'user',
    })).toBeNull();
    expect(notifier.notifyTaskCompleted).not.toHaveBeenCalled();

    expect(await service.deliverTaskCompletion(notifier, {
      taskId: 'task_done',
      title: 'Done',
      summary: 'summary',
      output: 'output',
      artifactPaths: [],
      durationMs: 100,
      executionMode: 'resume-blocked',
      origin: 'user',
    })).toBeNull();
    expect(notifier.notifyTaskCompleted).toHaveBeenCalledTimes(1);
  });

  it('delivers memory candidate notifications without blocking callers', () => {
    const notifier = {
      notifyMemoryCandidate: vi.fn().mockResolvedValue(undefined),
      notifyTaskCompleted: vi.fn(),
    };
    const service = new VerificationAndDeliveryService();

    service.deliverMemoryCandidate(notifier, {
      observationId: 'obs_1',
      pattern: '长期偏好',
      source: 'high-confidence',
    });

    expect(notifier.notifyMemoryCandidate).toHaveBeenCalledWith({
      observationId: 'obs_1',
      pattern: '长期偏好',
      source: 'high-confidence',
    });
  });

  it('formats blocked recovery completion output in the delivery boundary', () => {
    const lines: string[] = [];
    new VerificationAndDeliveryService().appendBlockedRecoveryCompletionBlock(lines, {
      task: {
        id: 'task_blocked',
        title: '旧任务',
        goal: '完成旧任务',
        summary: '',
        status: 'done',
        prioritySignals: {},
        resources: [],
        injectedPreferences: [],
        artifacts: [],
        dependencies: [{
          taskId: 'task_blocked',
          type: 'manual',
          description: '网络失败',
          status: 'waiting',
          createdAt: '2026-06-22T00:00:00.000Z',
        }],
        snapshots: [],
        interruptionCount: 0,
        lastInterruptionReason: '',
        lastSchedulingReason: '',
        createdAt: '2026-06-22T00:00:00.000Z',
        updatedAt: '2026-06-22T00:00:00.000Z',
      },
      summary: '已完成旧任务',
      output: '详细输出',
      recoveryTrigger: {
        kind: 'natural-language-resume',
        blockedReason: '网络失败',
        triggerReason: '用户要求继续',
        sourceInputExcerpt: '继续',
      },
    });

    expect(lines.join('\n')).toContain('✓ 旧阻塞任务已完成');
    expect(lines.join('\n')).toContain('触发方式：你刚才用自然语言要求继续旧阻塞任务');
    expect(lines.join('\n')).toContain('答案摘要：已完成旧任务');
  });
});
