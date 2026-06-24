import { describe, expect, it } from 'vitest';
import { IntentOrchestrator, type IntentDecisionV2, type IntentOrchestratorInput } from '../../src/core/intent-orchestrator.js';
import type { ExecutorProfile } from '../../src/core/executor-router.js';
import type { RuleHint } from '../../src/core/rule-hints-provider.js';
import type { SemanticIntentDecision } from '../../src/core/semantic-intent-router.js';

const profiles: ExecutorProfile[] = [
  profile('codex-cli', ['coding', 'tests']),
  profile('pi-agent', ['research', 'report_generation']),
  profile('hermes-agent', ['research', 'automation']),
];

type Expected = {
  interactionType: IntentDecisionV2['interactionType'];
  binding: IntentDecisionV2['task']['binding'];
  control: IntentDecisionV2['task']['control'];
  executionMode: IntentDecisionV2['execution']['mode'];
  riskLevel: IntentDecisionV2['risk']['level'];
  requiresConfirmation: boolean;
};

type Case = {
  input: string;
  semantic: Partial<SemanticIntentDecision>;
  hints?: RuleHint[];
  expected: Expected;
};

function profile(name: string, capabilities: string[]): ExecutorProfile {
  return {
    name,
    domains: capabilities,
    capabilities,
    inputTypes: ['text'],
    outputTypes: ['markdown'],
    strengths: [],
    weaknesses: [],
    riskLevel: 'medium',
    availability: 'available',
    historicalSuccess: 0.8,
  };
}

function baseSemantic(overrides: Partial<SemanticIntentDecision>): SemanticIntentDecision {
  return {
    interactionType: 'direct_reply',
    confidence: 0.86,
    shouldAskBeforeActing: false,
    ambiguity: [],
    risk: 'low',
    reason: 'golden semantic decision',
    clarificationQuestion: null,
    taskBinding: {
      type: 'none',
      taskId: null,
      reason: 'none',
    },
    taskControl: null,
    executorDecision: null,
    fallback: false,
    ...overrides,
  };
}

function executorDecision(mode: 'single' | 'race' = 'single', primaryIntent: 'repo_execution' | 'research_workflow' | 'general' = 'general') {
  return {
    selectedExecutor: primaryIntent === 'research_workflow' ? 'pi-agent' : 'codex-cli',
    action: mode === 'race' ? 'race_executors' as const : 'auto_dispatch' as const,
    confidence: 0.84,
    candidates: primaryIntent === 'research_workflow'
      ? [
          { executorName: 'pi-agent', score: 0.84, reason: 'research', primaryIntent, matchedBoundary: ['research'] },
          { executorName: 'hermes-agent', score: 0.76, reason: 'research', primaryIntent, matchedBoundary: ['research'] },
        ]
      : [
          { executorName: 'codex-cli', score: 0.84, reason: 'default', primaryIntent, matchedBoundary: [primaryIntent] },
        ],
    reason: primaryIntent,
    primaryIntent,
    matchedBoundary: [primaryIntent],
    rejected: [],
  };
}

function statusHint(scope: string): RuleHint {
  return { source: 'heuristic', kind: 'status_query', weight: 0.75, reason: 'status query', evidence: scope };
}

function clearHint(scope: string): RuleHint {
  return { source: 'parser', kind: 'clear_tasks', weight: 0.95, reason: 'clear tasks', evidence: scope };
}

function riskHint(): RuleHint {
  return { source: 'safety_guard', kind: 'risk_external_send', weight: 1, reason: 'external send', evidence: 'send' };
}

const conversationInputs = [
  '你好', '在吗', '解释一下这个概念', 'What is MetaClaw?', '帮我理解这句话',
  '继续讲讲', '这个思路对吗', '总结一下你刚才说的', 'hi', 'thanks',
];
const statusInputs = [
  '当前有没有被阻塞的任务？', '有哪些 blocked 任务', '任务状态怎么样', '现在跑到哪里了', '有没有正在执行的任务',
  'show task dashboard', '列出任务队列', '当前任务进度', '还有哪些任务', '有没有完成',
];
const clearInputs = [
  '清空阻塞任务', '清理所有任务', '取消全部任务', '删除所有 parked tasks', '清空挂起任务',
  'clear all tasks', '取消当前任务', '清理 blocked', '清除所有未完成任务', '清空任务队列',
];
const durableInputs = [
  '整理一份架构方案', '写一份竞品分析报告', '帮我实现这个功能', '修复 TypeScript bug', '生成项目总结',
  '调研新能源市场', '做一个数据对比', '写测试覆盖这个模块', '分析这段日志', '输出迁移计划',
];
const executorInputs = [
  '用 codex 修改仓库代码', 'run tests and fix failures', '实现 CLI 参数解析', '更新 README', '重构 executor registry',
  '检查 lint 错误', '新增数据库迁移', '修复 TUI 渲染', '实现 gateway adapter', '补集成测试',
];
const researchInputs = [
  '调研 pi-agent 和 hermes-agent 差异', 'research latest architecture options', '写行业研究报告', '对比三个方案',
  '收集资料并给结论', '分析市场份额', '研究竞品路线', '做资料综述', '调研开源实现', '输出来源限制说明',
];
const raceInputs = [
  '让 pi-agent 和 hermes-agent 竞速调研', '多个研究 agent 同时查资料', 'race research executors',
  '并行调研后采用最快结果', '两个调研执行器一起跑', 'research race this topic', '竞速找资料',
  '让研究执行器比一比', '并发调研报告', '多路调研汇总',
];
const resumeInputs = [
  '继续刚才那个任务', '恢复之前挂起的任务', '网络好了继续', '已授权，继续刚才任务', 'resume task_123',
  '继续之前阻塞任务', '把上次的任务跑完', '继续完成刚才报告', '恢复 task_abc', '接着之前的工作',
];
const followUpInputs = [
  '基于刚才结果继续扩展', '对已完成任务做 follow-up', '把刚才报告改成英文', '继续上一个完成任务的新版本',
  '基于上次产物生成摘要', '复用刚才结论做 PPT', '对完成结果再 review', '把上个任务结果发散一下',
  '在刚才基础上加测试', '基于最终报告写邮件草稿',
];
const riskInputs = [
  '把报告发给客户', '提交给法务', '对外发送这个结论', '群发给用户', '发出去',
  'send this to customer', '提交财务承诺', '自动外发', '发给对方', '发送到客户群',
];
const clarificationInputs = [
  '处理一下', '那个继续一下', '做一下这个', '你看着办', '继续那个东西',
  'fix it', 'run it', '搞一下', '按之前那样', '弄好',
];

function cases(): Case[] {
  return [
    ...conversationInputs.map(input => ({
      input,
      semantic: { interactionType: 'direct_reply' as const },
      expected: expected('direct_reply', 'none', 'none', 'none', 'low', false),
    })),
    ...statusInputs.map(input => ({
      input,
      semantic: {
        interactionType: 'task_control' as const,
        taskBinding: { type: 'none', taskId: null, reason: 'status query' },
        taskControl: { kind: 'status_query', taskId: null, scope: input.includes('阻塞') || input.includes('blocked') ? 'blocked' : 'dashboard', reason: 'status query' },
      },
      hints: [statusHint(input.includes('阻塞') || input.includes('blocked') ? 'blocked' : 'dashboard')],
      expected: expected('task_control', 'none', 'status_query', 'none', 'low', false),
    })),
    ...clearInputs.map(input => ({
      input,
      semantic: {
        interactionType: 'task_control' as const,
        taskBinding: { type: 'none', taskId: null, reason: 'clear tasks' },
        taskControl: { kind: 'clear_tasks', taskId: null, scope: input.includes('挂起') || input.includes('parked') ? 'parked' : input.includes('阻塞') || input.includes('blocked') ? 'blocked' : 'all', reason: 'clear tasks' },
      },
      hints: [clearHint(input.includes('挂起') || input.includes('parked') ? 'parked' : input.includes('阻塞') || input.includes('blocked') ? 'blocked' : 'all')],
      expected: expected('task_control', 'none', 'clear_tasks', 'none', 'low', false),
    })),
    ...durableInputs.map(input => ({
      input,
      semantic: { interactionType: 'durable_task' as const, taskBinding: { type: 'new', taskId: null, reason: 'new task' }, executorDecision: executorDecision() },
      expected: expected('durable_task', 'new', 'none', 'single_executor', 'low', false),
    })),
    ...executorInputs.map(input => ({
      input,
      semantic: { interactionType: 'executor_dispatch' as const, taskBinding: { type: 'new', taskId: null, reason: 'repo' }, executorDecision: executorDecision('single', 'repo_execution') },
      expected: expected('executor_dispatch', 'new', 'none', 'single_executor', 'low', false),
    })),
    ...researchInputs.map(input => ({
      input,
      semantic: { interactionType: 'durable_task' as const, taskBinding: { type: 'new', taskId: null, reason: 'research' }, executorDecision: executorDecision('single', 'research_workflow') },
      expected: expected('durable_task', 'new', 'none', 'single_executor', 'low', false),
    })),
    ...raceInputs.map(input => ({
      input,
      semantic: { interactionType: 'executor_dispatch' as const, taskBinding: { type: 'new', taskId: null, reason: 'race' }, executorDecision: executorDecision('race', 'research_workflow') },
      expected: expected('executor_dispatch', 'new', 'none', 'race_executors', 'low', false),
    })),
    ...resumeInputs.map(input => ({
      input,
      semantic: { interactionType: 'task_control' as const, taskBinding: { type: 'reference', taskId: 'task_1', reason: 'resume' }, taskControl: { kind: 'resume_task', taskId: 'task_1', scope: null, reason: 'resume' } },
      expected: expected('task_control', 'reference', 'resume_task', 'none', 'low', false),
    })),
    ...followUpInputs.map(input => ({
      input,
      semantic: { interactionType: 'durable_task' as const, taskBinding: { type: 'new', taskId: null, reason: 'follow up' }, executorDecision: executorDecision() },
      expected: expected('durable_task', 'new', 'none', 'single_executor', 'low', false),
    })),
    ...riskInputs.map(input => ({
      input,
      semantic: { interactionType: 'executor_dispatch' as const, risk: 'medium' as const, taskBinding: { type: 'new', taskId: null, reason: 'external' }, executorDecision: executorDecision() },
      hints: [riskHint()],
      expected: expected('clarification', 'new', 'none', 'none', 'medium', true),
    })),
    ...clarificationInputs.map(input => ({
      input,
      semantic: { interactionType: 'clarification' as const, confidence: 0.2, shouldAskBeforeActing: true, taskBinding: { type: 'none', taskId: null, reason: 'ambiguous' } },
      expected: expected('clarification', 'none', 'none', 'none', 'low', true),
    })),
  ];
}

function expected(
  interactionType: Expected['interactionType'],
  binding: Expected['binding'],
  control: Expected['control'],
  executionMode: Expected['executionMode'],
  riskLevel: Expected['riskLevel'],
  requiresConfirmation: boolean,
): Expected {
  return { interactionType, binding, control, executionMode, riskLevel, requiresConfirmation };
}

function inputFor(testCase: Case): IntentOrchestratorInput {
  return {
    userInput: testCase.input,
    recentTasks: [{ id: 'task_1', title: '旧任务', goal: '旧任务', summary: '', status: 'parked' }],
    executorProfiles: profiles,
    defaultExecutorName: 'codex-cli',
    currentFocus: null,
    hints: testCase.hints ?? [],
    allowDurableTask: true,
    allowFileModification: true,
    timeoutMs: 100,
  };
}

describe('golden intent corpus', () => {
  it('covers at least 100 stable Chinese and English natural-language intent cases', () => {
    expect(cases().length).toBeGreaterThanOrEqual(100);
    expect(cases().length).toBeLessThanOrEqual(200);
  });

  it.each(cases())('routes "$input"', async (testCase) => {
    const orchestrator = new IntentOrchestrator({
      semanticRouter: {
        decide: async () => baseSemantic(testCase.semantic),
      },
    });

    const decision = await orchestrator.decide(inputFor(testCase));

    expect({
      interactionType: decision.interactionType,
      binding: decision.task.binding,
      control: decision.task.control,
      executionMode: decision.execution.mode,
      riskLevel: decision.risk.level,
      requiresConfirmation: decision.risk.requiresConfirmation,
    }).toEqual(testCase.expected);
  });
});
