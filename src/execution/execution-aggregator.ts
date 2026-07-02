import type { AggregationPlan, ExecutionSubtask } from '../core/execution-strategy-planner.js';
import type { SubtaskResult } from './multi-executor-orchestrator.js';

export interface ExecutionAggregationInput {
  subtasks: ExecutionSubtask[];
  results: SubtaskResult[];
  aggregation: AggregationPlan;
}

export interface ExecutionVerificationConcern {
  subtaskId: string;
  criterionId: string;
  severity: 'warning' | 'error';
  message: string;
  feedback: string;
}

export interface ExecutionAggregationResult {
  status: 'pass' | 'concerns';
  finalOutput: string;
  concerns: ExecutionVerificationConcern[];
  artifacts: string[];
  retryFeedback: Array<{
    subtaskId: string;
    feedback: string;
  }>;
}

function hasTestEvidence(output: string): boolean {
  return /(npm test|npm run|vitest|jest|pytest|go test|cargo test|测试通过|未运行测试|未跑测试|not run tests|tests not run)/i.test(output);
}

function hasResearchSourceEvidence(output: string): boolean {
  return /(来源|source|http:\/\/|https:\/\/|限制|未联网|无法访问|资料)/i.test(output);
}

function hasReviewVerdict(output: string): boolean {
  return /\b(pass|concerns)\b|通过|风险|问题|未通过|建议/i.test(output);
}

function hasConflict(left: SubtaskResult, right: SubtaskResult): boolean {
  const pair = `${left.output}\n${right.output}`;
  return /(冲突|conflict|contradict|不一致)/i.test(pair);
}

export class ExecutionAggregator {
  aggregate(input: ExecutionAggregationInput): ExecutionAggregationResult {
    const concerns = this.verify(input);
    const artifacts = Array.from(new Set(input.results.flatMap(result => result.artifacts)));
    const status: ExecutionAggregationResult['status'] = concerns.some(concern => concern.severity === 'error')
      ? 'concerns'
      : concerns.length > 0 ? 'concerns' : 'pass';

    return {
      status,
      finalOutput: this.buildFinalOutput(input, concerns, artifacts),
      concerns,
      artifacts,
      retryFeedback: this.buildRetryFeedback(concerns),
    };
  }

  private verify(input: ExecutionAggregationInput): ExecutionVerificationConcern[] {
    const concerns: ExecutionVerificationConcern[] = [];
    const resultsById = new Map(input.results.map(result => [result.subtaskId, result]));

    for (const unit of input.subtasks) {
      const result = resultsById.get(unit.id);
      if (!result) {
        concerns.push({
          subtaskId: unit.id,
          criterionId: 'subtask_result_present',
          severity: 'error',
          message: '缺少 subtask 执行结果',
          feedback: '请重新执行该 subtask，并返回完整执行结果。',
        });
        continue;
      }

      if (result.status !== 'success') {
        concerns.push({
          subtaskId: unit.id,
          criterionId: 'subtask_success',
          severity: 'error',
          message: `subtask 未成功完成：${result.status}`,
          feedback: `请修复失败原因后重新执行。失败状态：${result.status}。错误：${result.error ?? result.output}`,
        });
        continue;
      }

      if (unit.expectedOutput === 'patch' && !hasTestEvidence(result.output)) {
        concerns.push({
          subtaskId: unit.id,
          criterionId: 'patch_verified',
          severity: 'warning',
          message: 'patch 类 subtask 未提供测试命令或未运行测试说明',
          feedback: '请补充测试命令和测试结果；如果不能运行测试，明确说明原因和风险。',
        });
      }

      if (unit.expectedOutput === 'analysis' && !hasResearchSourceEvidence(result.output)) {
        concerns.push({
          subtaskId: unit.id,
          criterionId: 'research_sourced',
          severity: 'warning',
          message: 'research/analysis 类 subtask 未列出来源或来源限制',
          feedback: '请补充来源、材料范围或来源限制，避免无依据结论。',
        });
      }

      if (unit.expectedOutput === 'review' && !hasReviewVerdict(result.output)) {
        concerns.push({
          subtaskId: unit.id,
          criterionId: 'review_verdict',
          severity: 'warning',
          message: 'review 类 subtask 未给出 pass 或 concerns',
          feedback: '请给出明确 pass 或 concerns，并列出剩余风险。',
        });
      }

      if (unit.expectedOutput === 'artifact' && result.artifacts.length === 0) {
        concerns.push({
          subtaskId: unit.id,
          criterionId: 'artifact_delivered',
          severity: 'warning',
          message: 'artifact 类 subtask 未返回文件路径',
          feedback: '请返回可定位的文件路径，或提供完整最终内容。',
        });
      }
    }

    for (let leftIndex = 0; leftIndex < input.results.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < input.results.length; rightIndex += 1) {
        const left = input.results[leftIndex]!;
        const right = input.results[rightIndex]!;
        if (hasConflict(left, right)) {
          concerns.push({
            subtaskId: `${left.subtaskId},${right.subtaskId}`,
            criterionId: 'cross_subtask_consistency',
            severity: 'warning',
            message: '不同 subtask 输出存在冲突或不一致，需要人工确认',
            feedback: '请对冲突结论进行复核，明确采用哪个结论以及理由。',
          });
        }
      }
    }

    return concerns;
  }

  private buildFinalOutput(
    input: ExecutionAggregationInput,
    concerns: ExecutionVerificationConcern[],
    artifacts: string[],
  ): string {
    const resultLines = input.results.map(result => [
      `## ${result.subtaskId} (${result.executorName}, ${result.status})`,
      result.output.trim() || '(no output)',
    ].join('\n'));

    return [
      '# Multi-executor result',
      '',
      concerns.length === 0 ? 'Verification: pass' : 'Verification: concerns',
      concerns.length > 0
        ? concerns.map(concern => `- [${concern.severity}] ${concern.subtaskId} (${concern.criterionId}): ${concern.message}`).join('\n')
        : '',
      artifacts.length > 0 ? `Artifacts:\n${artifacts.map(artifact => `- ${artifact}`).join('\n')}` : '',
      '',
      ...resultLines,
      '',
      `Aggregation mode: ${input.aggregation.mode}`,
      `Conflict policy: ${input.aggregation.conflictPolicy}`,
    ].filter(line => line !== '').join('\n');
  }

  private buildRetryFeedback(
    concerns: ExecutionVerificationConcern[],
  ): Array<{ subtaskId: string; feedback: string }> {
    const feedbackBySubtask = new Map<string, string[]>();
    for (const concern of concerns) {
      for (const subtaskId of concern.subtaskId.split(',')) {
        const trimmed = subtaskId.trim();
        if (!trimmed) {
          continue;
        }
        const feedback = feedbackBySubtask.get(trimmed) ?? [];
        feedback.push(`[${concern.criterionId}] ${concern.feedback}`);
        feedbackBySubtask.set(trimmed, feedback);
      }
    }

    return Array.from(feedbackBySubtask.entries()).map(([subtaskId, feedback]) => ({
      subtaskId,
      feedback: feedback.join('\n'),
    }));
  }
}
