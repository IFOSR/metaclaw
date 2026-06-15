import type { AggregationPlan, ExecutionWorkUnit } from './execution-strategy-planner.js';
import type { WorkUnitResult } from './multi-executor-orchestrator.js';

export interface ExecutionAggregationInput {
  workUnits: ExecutionWorkUnit[];
  results: WorkUnitResult[];
  aggregation: AggregationPlan;
}

export interface ExecutionVerificationConcern {
  workUnitId: string;
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
    workUnitId: string;
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

function hasConflict(left: WorkUnitResult, right: WorkUnitResult): boolean {
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
    const resultsById = new Map(input.results.map(result => [result.workUnitId, result]));

    for (const unit of input.workUnits) {
      const result = resultsById.get(unit.id);
      if (!result) {
        concerns.push({
          workUnitId: unit.id,
          criterionId: 'work_unit_result_present',
          severity: 'error',
          message: '缺少 work unit 执行结果',
          feedback: '请重新执行该 work unit，并返回完整执行结果。',
        });
        continue;
      }

      if (result.status !== 'success') {
        concerns.push({
          workUnitId: unit.id,
          criterionId: 'work_unit_success',
          severity: 'error',
          message: `work unit 未成功完成：${result.status}`,
          feedback: `请修复失败原因后重新执行。失败状态：${result.status}。错误：${result.error ?? result.output}`,
        });
        continue;
      }

      if (unit.expectedOutput === 'patch' && !hasTestEvidence(result.output)) {
        concerns.push({
          workUnitId: unit.id,
          criterionId: 'patch_verified',
          severity: 'warning',
          message: 'patch 类 work unit 未提供测试命令或未运行测试说明',
          feedback: '请补充测试命令和测试结果；如果不能运行测试，明确说明原因和风险。',
        });
      }

      if (unit.expectedOutput === 'analysis' && !hasResearchSourceEvidence(result.output)) {
        concerns.push({
          workUnitId: unit.id,
          criterionId: 'research_sourced',
          severity: 'warning',
          message: 'research/analysis 类 work unit 未列出来源或来源限制',
          feedback: '请补充来源、材料范围或来源限制，避免无依据结论。',
        });
      }

      if (unit.expectedOutput === 'review' && !hasReviewVerdict(result.output)) {
        concerns.push({
          workUnitId: unit.id,
          criterionId: 'review_verdict',
          severity: 'warning',
          message: 'review 类 work unit 未给出 pass 或 concerns',
          feedback: '请给出明确 pass 或 concerns，并列出剩余风险。',
        });
      }

      if (unit.expectedOutput === 'artifact' && result.artifacts.length === 0) {
        concerns.push({
          workUnitId: unit.id,
          criterionId: 'artifact_delivered',
          severity: 'warning',
          message: 'artifact 类 work unit 未返回文件路径',
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
            workUnitId: `${left.workUnitId},${right.workUnitId}`,
            criterionId: 'cross_work_unit_consistency',
            severity: 'warning',
            message: '不同 work unit 输出存在冲突或不一致，需要人工确认',
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
      `## ${result.workUnitId} (${result.executorName}, ${result.status})`,
      result.output.trim() || '(no output)',
    ].join('\n'));

    return [
      '# Multi-executor result',
      '',
      concerns.length === 0 ? 'Verification: pass' : 'Verification: concerns',
      concerns.length > 0
        ? concerns.map(concern => `- [${concern.severity}] ${concern.workUnitId} (${concern.criterionId}): ${concern.message}`).join('\n')
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
  ): Array<{ workUnitId: string; feedback: string }> {
    const feedbackByWorkUnit = new Map<string, string[]>();
    for (const concern of concerns) {
      for (const workUnitId of concern.workUnitId.split(',')) {
        const trimmed = workUnitId.trim();
        if (!trimmed) {
          continue;
        }
        const feedback = feedbackByWorkUnit.get(trimmed) ?? [];
        feedback.push(`[${concern.criterionId}] ${concern.feedback}`);
        feedbackByWorkUnit.set(trimmed, feedback);
      }
    }

    return Array.from(feedbackByWorkUnit.entries()).map(([workUnitId, feedback]) => ({
      workUnitId,
      feedback: feedback.join('\n'),
    }));
  }
}
