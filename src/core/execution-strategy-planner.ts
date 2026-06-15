import type { Task } from './types.js';
import type { ExecutionPlan } from '../session/session-helpers.js';
import type { ExecutorRouteDecision } from './executor-router.js';
import type { RetrievedTaskCandidate } from './hybrid-task-retriever.js';

export interface ExecutionStrategyInput {
  task: Task;
  userPrompt: string;
  executionPlan: ExecutionPlan;
  routeDecision: ExecutorRouteDecision;
  retrievedTasks: RetrievedTaskCandidate[];
  resources: string[];
}

export interface ExecutionWorkUnit {
  id: string;
  title: string;
  goal: string;
  executorHint: string;
  dependsOn: string[];
  inputs: {
    taskId: string;
    resources: string[];
    recalledTaskIds: string[];
  };
  expectedOutput: 'analysis' | 'patch' | 'artifact' | 'review' | 'summary';
  acceptance: string[];
  riskLevel: 'low' | 'medium' | 'high';
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  requiredEvidence: string[];
  severity: 'must' | 'should';
  appliesToWorkUnitIds: string[];
}

export interface AggregationPlan {
  mode: 'summarize' | 'verify_and_summarize';
  acceptance: string[];
  criteria: AcceptanceCriterion[];
  conflictPolicy: 'flag_conflicts' | 'prefer_primary_executor';
  maxIterations: number;
}

export type ExecutionStrategy =
  | {
      mode: 'single_executor';
      reason: string;
      executorName: string;
    }
  | {
      mode: 'multi_executor';
      reason: string;
      workUnits: ExecutionWorkUnit[];
      aggregation: AggregationPlan;
    };

interface ComplexitySignal {
  kind: 'multi_domain' | 'stage_dependency' | 'high_risk_validation' | 'multi_source_synthesis' | 'explicit_multi_agent';
  reason: string;
  weight: number;
}

const RESEARCH_TERMS = ['调研', '研究', '竞品', '市场', '资料', '搜索', 'research'];
const IMPLEMENTATION_TERMS = ['实现', '修复', '修改', '代码', '补丁', 'patch', 'repo', '仓库', '测试', 'test'];
const REVIEW_TERMS = ['review', '审查', '评审', '验证', '验收', '风险'];
const DOCUMENT_TERMS = ['文档', '报告', '方案', 'README', '总结', '邮件', '说明'];
const STAGE_TERMS = ['先', '再', '然后', '最后', '之后', '分阶段', '第一步', '第二步'];
const EXPLICIT_MULTI_AGENT_TERMS = ['不同 agent', '多个 agent', '多执行器', '并行', '一个负责', '分别做', '两个方案', '多视角', 'subagent'];
const HIGH_RISK_TERMS = ['生产', '线上', '删除', '客户外发', '对外发送', '合同', '法律', '财务', '大规模重构', 'force push', 'rm -rf'];

function containsAny(input: string, terms: string[]): boolean {
  const normalized = input.toLowerCase();
  return terms.some(term => normalized.includes(term.toLowerCase()));
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function getDomainCount(prompt: string): number {
  return [
    containsAny(prompt, RESEARCH_TERMS),
    containsAny(prompt, IMPLEMENTATION_TERMS),
    containsAny(prompt, REVIEW_TERMS),
    containsAny(prompt, DOCUMENT_TERMS),
  ].filter(Boolean).length;
}

function hasRepoMutation(input: ExecutionStrategyInput): boolean {
  return input.routeDecision.primaryIntent === 'repo_execution'
    || input.routeDecision.matchedBoundary.includes('repo_mutation')
    || containsAny(input.userPrompt, IMPLEMENTATION_TERMS);
}

function preferredResearchExecutor(input: ExecutionStrategyInput): string {
  if (input.routeDecision.selectedExecutor === 'hermes-agent' || input.routeDecision.selectedExecutor === 'pi-agent') {
    return input.routeDecision.selectedExecutor;
  }
  return 'hermes-agent';
}

function preferredReviewExecutor(input: ExecutionStrategyInput): string {
  if (input.routeDecision.selectedExecutor === 'deepseek-tui') {
    return 'deepseek-tui';
  }
  return 'codex-cli';
}

function buildSignals(input: ExecutionStrategyInput): ComplexitySignal[] {
  const prompt = input.userPrompt;
  const signals: ComplexitySignal[] = [];
  const domainCount = getDomainCount(prompt);

  if (containsAny(prompt, EXPLICIT_MULTI_AGENT_TERMS)) {
    signals.push({
      kind: 'explicit_multi_agent',
      reason: '用户显式要求多 agent、多视角或并行协作',
      weight: 3,
    });
  }

  if (domainCount >= 2) {
    signals.push({
      kind: 'multi_domain',
      reason: `任务同时涉及 ${domainCount} 个能力域`,
      weight: 2,
    });
  }

  if (containsAny(prompt, STAGE_TERMS) && domainCount >= 2) {
    signals.push({
      kind: 'stage_dependency',
      reason: '任务存在先后阶段依赖',
      weight: 2,
    });
  }

  if ((hasRepoMutation(input) && containsAny(prompt, REVIEW_TERMS)) || containsAny(prompt, HIGH_RISK_TERMS)) {
    signals.push({
      kind: 'high_risk_validation',
      reason: '任务包含 repo mutation、高风险动作或显式验收审查',
      weight: 2,
    });
  }

  if (input.retrievedTasks.length >= 2 || input.resources.length >= 2) {
    signals.push({
      kind: 'multi_source_synthesis',
      reason: '任务需要综合多个历史任务或资源来源',
      weight: 1,
    });
  }

  return signals;
}

export class ExecutionStrategyPlanner {
  plan(input: ExecutionStrategyInput): ExecutionStrategy {
    const signals = buildSignals(input);
    const totalWeight = signals.reduce((sum, signal) => sum + signal.weight, 0);
    const shouldUseMultiExecutor = signals.some(signal => signal.kind === 'explicit_multi_agent')
      || totalWeight >= 3;

    if (!shouldUseMultiExecutor) {
      return {
        mode: 'single_executor',
        executorName: input.routeDecision.selectedExecutor,
        reason: signals.length === 0
          ? '未命中复杂任务强信号，保持单 executor 执行'
          : `复杂度信号不足以拆分：${signals.map(signal => signal.reason).join('；')}`,
      };
    }

    const workUnits = this.buildWorkUnits(input, signals);
    return {
      mode: 'multi_executor',
      reason: `命中复杂任务强信号：${signals.map(signal => signal.reason).join('；')}`,
      workUnits,
      aggregation: {
        mode: workUnits.some(unit => unit.expectedOutput === 'patch' || unit.expectedOutput === 'review')
          ? 'verify_and_summarize'
          : 'summarize',
        acceptance: unique(workUnits.flatMap(unit => unit.acceptance)),
        criteria: this.buildAcceptanceCriteria(input, workUnits),
        conflictPolicy: 'flag_conflicts',
        maxIterations: 2,
      },
    };
  }

  private buildAcceptanceCriteria(
    input: ExecutionStrategyInput,
    workUnits: ExecutionWorkUnit[],
  ): AcceptanceCriterion[] {
    const criteria: AcceptanceCriterion[] = [{
      id: 'user_request_satisfied',
      description: `最终结果必须回应用户原始需求：${input.userPrompt}`,
      requiredEvidence: ['最终汇总说明每个用户需求点如何被满足'],
      severity: 'must',
      appliesToWorkUnitIds: workUnits.map(unit => unit.id),
    }];

    const patchUnitIds = workUnits.filter(unit => unit.expectedOutput === 'patch').map(unit => unit.id);
    if (patchUnitIds.length > 0) {
      criteria.push({
        id: 'patch_verified',
        description: '代码或仓库修改必须提供测试命令，或明确说明未运行测试的原因',
        requiredEvidence: ['测试命令', '测试结果', '未运行测试原因'],
        severity: 'must',
        appliesToWorkUnitIds: patchUnitIds,
      });
    }

    const researchUnitIds = workUnits.filter(unit => unit.expectedOutput === 'analysis').map(unit => unit.id);
    if (researchUnitIds.length > 0) {
      criteria.push({
        id: 'research_sourced',
        description: '调研或分析必须说明来源、材料范围或来源限制',
        requiredEvidence: ['来源', '材料范围', '来源限制'],
        severity: 'should',
        appliesToWorkUnitIds: researchUnitIds,
      });
    }

    const artifactUnitIds = workUnits.filter(unit => unit.expectedOutput === 'artifact').map(unit => unit.id);
    if (artifactUnitIds.length > 0) {
      criteria.push({
        id: 'artifact_delivered',
        description: '文档、报告或其他产物必须返回可定位的文件路径或完整最终内容',
        requiredEvidence: ['文件路径', '最终内容'],
        severity: 'must',
        appliesToWorkUnitIds: artifactUnitIds,
      });
    }

    const reviewUnitIds = workUnits.filter(unit => unit.expectedOutput === 'review').map(unit => unit.id);
    if (reviewUnitIds.length > 0) {
      criteria.push({
        id: 'review_verdict',
        description: '独立验收审查必须给出 pass 或 concerns，并列出剩余风险',
        requiredEvidence: ['pass', 'concerns', '剩余风险'],
        severity: 'must',
        appliesToWorkUnitIds: reviewUnitIds,
      });
    }

    return criteria;
  }

  private buildWorkUnits(input: ExecutionStrategyInput, signals: ComplexitySignal[]): ExecutionWorkUnit[] {
    const recalledTaskIds = input.retrievedTasks.map(candidate => candidate.taskId);
    const units: ExecutionWorkUnit[] = [];
    const prompt = input.userPrompt;
    const needsResearch = containsAny(prompt, RESEARCH_TERMS)
      || signals.some(signal => signal.kind === 'multi_source_synthesis');
    const needsImplementation = hasRepoMutation(input);
    const needsReview = containsAny(prompt, REVIEW_TERMS)
      || signals.some(signal => signal.kind === 'high_risk_validation');
    const needsArtifact = containsAny(prompt, DOCUMENT_TERMS) && !needsImplementation;

    if (needsResearch) {
      units.push({
        id: 'wu_research',
        title: '调研与上下文归纳',
        goal: '汇总外部资料、历史任务和当前资源，形成后续执行依据',
        executorHint: preferredResearchExecutor(input),
        dependsOn: [],
        inputs: {
          taskId: input.task.id,
          resources: input.resources,
          recalledTaskIds,
        },
        expectedOutput: 'analysis',
        acceptance: ['列出关键发现、来源或来源限制', '指出对后续执行有影响的约束'],
        riskLevel: 'medium',
      });
    }

    if (needsImplementation) {
      units.push({
        id: 'wu_implementation',
        title: '实现或修改',
        goal: '在仓库中完成必要代码、文档或测试修改',
        executorHint: 'codex-cli',
        dependsOn: needsResearch ? ['wu_research'] : [],
        inputs: {
          taskId: input.task.id,
          resources: input.resources,
          recalledTaskIds,
        },
        expectedOutput: 'patch',
        acceptance: ['列出修改文件', '提供测试命令或说明未运行原因'],
        riskLevel: needsReview ? 'high' : 'medium',
      });
    } else if (needsArtifact) {
      units.push({
        id: 'wu_artifact',
        title: '产物生成',
        goal: '生成用户要求的文档、报告、方案或说明',
        executorHint: input.routeDecision.selectedExecutor,
        dependsOn: needsResearch ? ['wu_research'] : [],
        inputs: {
          taskId: input.task.id,
          resources: input.resources,
          recalledTaskIds,
        },
        expectedOutput: 'artifact',
        acceptance: ['返回产物路径或明确最终内容', '说明引用的材料范围'],
        riskLevel: 'medium',
      });
    }

    if (needsReview) {
      units.push({
        id: 'wu_review',
        title: '独立验收审查',
        goal: '检查前序产物是否满足验收条件并标记风险',
        executorHint: preferredReviewExecutor(input),
        dependsOn: units.length > 0 ? [units[units.length - 1]!.id] : [],
        inputs: {
          taskId: input.task.id,
          resources: input.resources,
          recalledTaskIds,
        },
        expectedOutput: 'review',
        acceptance: ['给出 pass 或 concerns', '标记冲突、缺失产物或未跑测试'],
        riskLevel: 'high',
      });
    }

    if (units.length === 0) {
      units.push({
        id: 'wu_summary',
        title: '综合总结',
        goal: '整合多来源上下文并给出最终结论',
        executorHint: input.routeDecision.selectedExecutor,
        dependsOn: [],
        inputs: {
          taskId: input.task.id,
          resources: input.resources,
          recalledTaskIds,
        },
        expectedOutput: 'summary',
        acceptance: ['输出最终结论', '说明依据和不确定性'],
        riskLevel: 'low',
      });
    }

    return units;
  }
}
