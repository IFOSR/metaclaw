export type ExecutorRiskLevel = 'low' | 'medium' | 'high';
export type ExecutorAvailability = 'available' | 'unavailable';
export type ExecutorRouteAction = 'auto_dispatch' | 'ask_review' | 'fallback_default';

export interface ExecutorProfile {
  name: string;
  domains: string[];
  capabilities: string[];
  inputTypes: string[];
  outputTypes: string[];
  strengths: string[];
  weaknesses: string[];
  riskLevel: ExecutorRiskLevel;
  availability: ExecutorAvailability;
  historicalSuccess: number;
}

export interface ExecutorRouteCandidate {
  executorName: string;
  score: number;
  reason: string;
}

export interface ExecutorRouteDecision {
  selectedExecutor: string;
  action: ExecutorRouteAction;
  confidence: number;
  candidates: ExecutorRouteCandidate[];
  reason: string;
}

const TOKEN_MAP: Record<string, string[]> = {
  legal: ['合同', '法务', '条款', '法律', 'contract', 'legal'],
  contract: ['合同', '条款', 'contract'],
  software: ['代码', '测试', '实现', 'bug', '修复', 'typescript', 'react'],
  repo: ['repo', '仓库', '代码库', '项目代码', '大代码库'],
  terminal: ['terminal', 'shell', '命令行', '终端'],
  code_review: ['review', 'code review', '代码审查', '评审'],
  tests: ['测试', 'test', 'tdd', 'vitest', 'jest'],
  debugging: ['debug', '调试', '排查', 'bug', '修复'],
  refactor: ['重构', 'refactor'],
  sandboxed_execution: ['sandbox', '沙箱'],
  noninteractive_execution: ['非交互', 'non-interactive', 'ci'],
  finance: ['财务', '投资', '估值', '收入', '利润'],
  analysis: ['分析', '评审', '风险', 'review', 'analysis'],
  research: ['调研', '研究', '分析', '报告'],
  personal_assistant: ['助手', 'assistant', '个人助理'],
  automation: ['自动化', 'automation', 'workflow', '工作流'],
  messaging: ['消息', '通知', 'message', 'messaging'],
  memory: ['记忆', 'memory', '长期记忆'],
  agent_ops: ['代理', '智能体', '编排', 'orchestration'],
  architecture: ['架构', 'architecture', '系统设计', '设计评审', 'system design'],
  multi_tool: ['多工具', '工具调用', 'tool', 'multi-tool'],
  mcp: ['mcp', 'tool server', '工具服务器'],
  skill_runtime: ['skill', '技能', '运行时'],
  session_management: ['session', '会话'],
  messaging_gateway: ['gateway', '网关', '消息网关', 'whatsapp'],
  workflow_automation: ['workflow', '工作流', '自动化'],
  persistent_memory: ['长期记忆', 'persistent memory', '记忆'],
  code_execution: ['执行代码', '运行代码', '代码执行'],
  subagents: ['subagent', '子代理', '子智能体'],
  ci_noninteractive: ['ci', '非交互', 'pipeline'],
  long_context_analysis: ['长上下文', 'large context', '大代码库'],
  architecture_review: ['架构评审', 'architecture review'],
  contract_review: ['审查', '合同', '条款'],
  risk_matrix: ['风险矩阵', '风险'],
  coding: ['代码', '实现', '修复'],
};

const SPECIALIZED_TOKENS = new Set([
  'architecture',
  'analysis',
  'architecture_review',
  'long_context_analysis',
  'persistent_memory',
  'multi_tool',
  'skill_runtime',
  'messaging_gateway',
  'workflow_automation',
  'personal_assistant',
]);

function shouldDeferHermesCandidate(userInput: string, candidate: ExecutorRouteCandidate): boolean {
  if (candidate.executorName !== 'hermes-agent') {
    return false;
  }

  const strongHermesTokens = [
    'automation',
    'multi_tool',
    'mcp',
    'skill_runtime',
    'messaging_gateway',
    'workflow_automation',
    'session_management',
    'personal_assistant',
  ];

  return !strongHermesTokens.some(token => matchScore(userInput, token));
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/\s+/g, '');
}

function matchScore(userInput: string, token: string): number {
  const normalized = normalize(userInput);
  const aliases = TOKEN_MAP[token] ?? [token];
  return aliases.some(alias => normalized.includes(normalize(alias))) ? 1 : 0;
}

export class ExecutorRouter {
  constructor(private profiles: ExecutorProfile[]) {}

  route(input: { userInput: string; defaultExecutorName: string; explicitExecutorName?: string }): ExecutorRouteDecision {
    if (input.explicitExecutorName) {
      return {
        selectedExecutor: input.explicitExecutorName,
        action: 'auto_dispatch',
        confidence: 1,
        candidates: [{
          executorName: input.explicitExecutorName,
          score: 1,
          reason: '用户显式指定 executor',
        }],
        reason: '用户显式指定 executor',
      };
    }

    const candidates = this.profiles
      .filter(profile => profile.availability === 'available')
      .map(profile => this.scoreProfile(profile, input.userInput))
      .map(candidate => shouldDeferHermesCandidate(input.userInput, candidate)
        ? {
          ...candidate,
          score: Math.min(candidate.score, 0.44),
          reason: `${candidate.reason}, hermes_strong_signal_missing`,
        }
        : candidate)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.reason.split(', ').length - left.reason.split(', ').length;
      });

    const best = candidates[0];
    if (!best || best.score < 0.45) {
      return {
        selectedExecutor: input.defaultExecutorName,
        action: 'fallback_default',
        confidence: best?.score ?? 0,
        candidates,
        reason: '没有足够高置信的 executor 匹配，回退默认 executor',
      };
    }

    const profile = this.profiles.find(item => item.name === best.executorName);
    const action: ExecutorRouteAction = profile?.riskLevel === 'high'
      ? 'ask_review'
      : best.score >= 0.75
        ? 'auto_dispatch'
        : 'ask_review';

    return {
      selectedExecutor: best.executorName,
      action,
      confidence: best.score,
      candidates,
      reason: best.reason,
    };
  }

  private scoreProfile(profile: ExecutorProfile, userInput: string): ExecutorRouteCandidate {
    let score = 0;
    const reasons: string[] = [];

    for (const domain of profile.domains) {
      if (matchScore(userInput, domain)) {
        score += SPECIALIZED_TOKENS.has(domain) ? 0.4 : 0.3;
        reasons.push(`domain=${domain}`);
      }
    }

    for (const capability of profile.capabilities) {
      if (matchScore(userInput, capability)) {
        score += SPECIALIZED_TOKENS.has(capability) ? 0.35 : 0.25;
        reasons.push(`capability=${capability}`);
      }
    }

    score += Math.max(0, Math.min(1, profile.historicalSuccess)) * 0.2;

    return {
      executorName: profile.name,
      score: Math.min(1, score),
      reason: reasons.length > 0 ? reasons.join(', ') : '历史成功率兜底',
    };
  }
}
