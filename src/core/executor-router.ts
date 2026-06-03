export type ExecutorRiskLevel = 'low' | 'medium' | 'high';
export type ExecutorAvailability = 'available' | 'unavailable';
export type ExecutorRouteAction = 'auto_dispatch' | 'ask_review' | 'fallback_default';
export type TaskRouteIntent =
  | 'repo_execution'
  | 'technical_reasoning'
  | 'research_workflow'
  | 'memory_agent_ops'
  | 'conversation_or_control'
  | 'general';

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
  primaryUseCases?: string[];
  avoidUseCases?: string[];
  intentAffinity?: Partial<Record<TaskRouteIntent, number>>;
  runtimeCommand?: string | null;
  runtimeArgs?: string[];
  runtimeCheckCommand?: string | null;
  projectUrl?: string | null;
}

export interface ExecutorRouteCandidate {
  executorName: string;
  score: number;
  reason: string;
  primaryIntent?: TaskRouteIntent;
  matchedBoundary?: string[];
}

export interface ExecutorRouteRejectedCandidate {
  executorName: string;
  reason: string;
  score: number;
}

export interface ExecutorRouteDecision {
  selectedExecutor: string;
  action: ExecutorRouteAction;
  confidence: number;
  candidates: ExecutorRouteCandidate[];
  reason: string;
  primaryIntent: TaskRouteIntent;
  matchedBoundary: string[];
  rejected: ExecutorRouteRejectedCandidate[];
}

interface IntentClassification {
  primaryIntent: TaskRouteIntent;
  matchedBoundary: string[];
  requiresRepoMutation: boolean;
  explicitExecutorName: string | null;
  riskyAction: boolean;
}

const TOKEN_MAP: Record<string, string[]> = {
  legal: ['合同', '法务', '条款', '法律', 'contract', 'legal'],
  contract: ['合同', '条款', 'contract'],
  software: ['代码', '测试', '实现', 'bug', '修复', 'typescript', 'react'],
  repo: ['repo', '仓库', '代码库', '项目代码', '大代码库', '当前项目'],
  terminal: ['terminal', 'shell', '命令行', '终端'],
  code_review: ['review', 'code review', '代码审查', '代码 review', '评审', 'pr review'],
  tests: ['测试', 'test', 'tests', 'tdd', 'vitest', 'jest', '跑测试', '修复测试'],
  debugging: ['debug', '调试', '排查', 'bug', '修复'],
  refactor: ['重构', 'refactor'],
  reasoning: ['推理', '深度思考', '复杂推理', 'reasoning'],
  algorithm: ['算法', 'leetcode', '数据结构', 'algorithm'],
  math: ['数学', '公式', '证明', '推导', 'math'],
  chinese_analysis: ['中文分析', '中文技术分析', '中文推理', '中文解释'],
  deepseek_reasoning: ['deepseek', 'deepseek-tui', '深度求索', 'deepseek reasoning', '推理模型'],
  agentic_tui: ['tui', 'terminal agent', '终端智能体', 'agentic'],
  sandboxed_execution: ['sandbox', '沙箱'],
  noninteractive_execution: ['非交互', 'non-interactive', 'ci'],
  finance: ['财务', '投资', '估值', '收入', '利润'],
  analysis: ['分析', '评审', '风险', 'review', 'analysis'],
  research: ['调研', '研究', '报告', 'research', '市场', '竞品', '公司', '产品分析'],
  reporting: ['报告', 'report', '调研报告', '研究报告'],
  personal_assistant: ['助手', 'assistant', '个人助理'],
  automation: ['自动化', 'automation', 'workflow', '工作流'],
  messaging: ['消息', '通知', 'message', 'messaging'],
  memory: ['记忆', 'memory', '长期记忆'],
  agent_ops: ['代理', '智能体', '编排', 'orchestration'],
  architecture: ['架构', 'architecture', '系统设计', '设计评审', 'system design', '技术取舍'],
  multi_tool: ['多工具', '工具调用', 'tool', 'multi-tool'],
  mcp: ['mcp', 'tool server', '工具服务器'],
  skill_runtime: ['skill', '技能', '运行时'],
  session_management: ['session', '会话', '跨 session', '跨session'],
  messaging_gateway: ['gateway', '网关', '消息网关', 'whatsapp'],
  workflow_automation: ['workflow', '工作流', '自动化'],
  persistent_memory: ['长期记忆', 'persistent memory', '记忆'],
  code_execution: ['执行代码', '运行代码', '代码执行'],
  agentic_cli: ['agent cli', 'agentic cli', 'coding agent', '智能体 cli'],
  report_generation: ['生成报告', '输出报告', '产出报告', 'report generation'],
  subagents: ['subagent', '子代理', '子智能体'],
  ci_noninteractive: ['ci', '非交互', 'pipeline'],
  long_context_analysis: ['长上下文', 'large context', '大代码库'],
  architecture_review: ['架构评审', 'architecture review'],
  contract_review: ['审查', '合同', '条款'],
  risk_matrix: ['风险矩阵', '风险'],
  coding: ['代码', '实现', '修复', '写入文件', 'patch', '补丁'],
};

const EXECUTOR_ALIASES: Record<string, string[]> = {
  'codex-cli': ['codex-cli', 'codex cli', 'codex'],
  'deepseek-tui': ['deepseek-tui', 'deepseek tui', 'deepseek', '深度求索'],
  'hermes-agent': ['hermes-agent', 'hermes agent', 'hermes'],
  'pi-agent': ['pi-agent', 'pi agent', 'piagent', 'pi'],
  'claude-code': ['claude-code', 'claude code', 'claude'],
};

const DEFAULT_INTENT_AFFINITY: Record<string, Partial<Record<TaskRouteIntent, number>>> = {
  'codex-cli': {
    repo_execution: 1,
    technical_reasoning: 0.45,
    research_workflow: 0.15,
    memory_agent_ops: 0.1,
    general: 0.35,
  },
  'deepseek-tui': {
    repo_execution: 0.55,
    technical_reasoning: 1,
    research_workflow: 0.25,
    memory_agent_ops: 0.15,
    general: 0.35,
  },
  'hermes-agent': {
    repo_execution: 0.15,
    technical_reasoning: 0.25,
    research_workflow: 1,
    memory_agent_ops: 1,
    general: 0.3,
  },
  'pi-agent': {
    repo_execution: 0.2,
    technical_reasoning: 0.45,
    research_workflow: 1,
    memory_agent_ops: 0.65,
    general: 0.35,
  },
  'claude-code': {
    repo_execution: 0.7,
    technical_reasoning: 0.75,
    research_workflow: 0.35,
    memory_agent_ops: 0.35,
    general: 0.35,
  },
};

const SPECIALIZED_TOKENS = new Set([
  'architecture',
  'analysis',
  'research',
  'reasoning',
  'algorithm',
  'math',
  'chinese_analysis',
  'deepseek_reasoning',
  'agentic_tui',
  'architecture_review',
  'long_context_analysis',
  'persistent_memory',
  'multi_tool',
  'skill_runtime',
  'messaging_gateway',
  'workflow_automation',
  'personal_assistant',
  'reporting',
  'report_generation',
  'agentic_cli',
]);

const REPO_MUTATION_TOKENS = [
  '实现', '修复', '改代码', '修改代码', '写代码', '补丁', 'patch', '跑测试', '修复测试', '重构', '写入文件', '直接修复',
  'implement', 'fix', 'edit', 'modify', 'write file', 'run tests', 'refactor', 'commit',
];
const NO_MUTATION_TOKENS = ['不改文件', '不要改文件', '只分析', '仅分析', '不修改', '不动代码', 'read-only', 'no edit', 'without editing'];
const CONVERSATION_TOKENS = ['聊聊', '解释一下', '怎么看', '想想', 'hello', '你好'];

function normalize(input: string): string {
  return input.toLowerCase().replace(/[\s_-]+/g, '');
}

function inputContainsAny(userInput: string, aliases: string[]): boolean {
  const normalized = normalize(userInput);
  return aliases.some(alias => normalized.includes(normalize(alias)));
}

function matchScore(userInput: string, token: string): number {
  const aliases = TOKEN_MAP[token] ?? [token];
  return inputContainsAny(userInput, aliases) ? 1 : 0;
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, score));
}

function detectExplicitExecutor(userInput: string, profiles: ExecutorProfile[]): string | null {
  for (const profile of profiles) {
    const aliases = EXECUTOR_ALIASES[profile.name] ?? [profile.name];
    if (inputContainsAny(userInput, aliases)) {
      return profile.name;
    }
  }
  return null;
}

function classifyIntent(userInput: string, profiles: ExecutorProfile[]): IntentClassification {
  const matchedBoundary: string[] = [];
  const hasNoMutation = inputContainsAny(userInput, NO_MUTATION_TOKENS);
  const requiresRepoMutation = !hasNoMutation && inputContainsAny(userInput, REPO_MUTATION_TOKENS);
  const explicitExecutorName = detectExplicitExecutor(userInput, profiles);

  if (requiresRepoMutation || matchScore(userInput, 'tests') || matchScore(userInput, 'debugging') || matchScore(userInput, 'refactor')) {
    matchedBoundary.push('repo_mutation');
  }
  if (matchScore(userInput, 'code_review')) matchedBoundary.push('code_review');
  if (matchScore(userInput, 'algorithm')) matchedBoundary.push('algorithm');
  if (matchScore(userInput, 'math')) matchedBoundary.push('math');
  if (matchScore(userInput, 'reasoning')) matchedBoundary.push('reasoning');
  if (matchScore(userInput, 'architecture')) matchedBoundary.push('architecture');
  if (matchScore(userInput, 'chinese_analysis')) matchedBoundary.push('chinese_analysis');
  if (matchScore(userInput, 'deepseek_reasoning')) matchedBoundary.push('deepseek_reasoning');
  if (matchScore(userInput, 'research')) matchedBoundary.push('research');
  if (matchScore(userInput, 'multi_tool')) matchedBoundary.push('multi_tool');
  if (matchScore(userInput, 'automation')) matchedBoundary.push('workflow_automation');
  if (matchScore(userInput, 'memory')) matchedBoundary.push('persistent_memory');
  if (matchScore(userInput, 'messaging') || matchScore(userInput, 'messaging_gateway')) matchedBoundary.push('messaging_gateway');
  if (matchScore(userInput, 'skill_runtime')) matchedBoundary.push('skill_runtime');
  if (matchScore(userInput, 'mcp')) matchedBoundary.push('mcp');

  const hasTechnicalReasoning = matchedBoundary.some(boundary => [
    'algorithm', 'math', 'reasoning', 'architecture', 'chinese_analysis', 'deepseek_reasoning', 'code_review',
  ].includes(boundary));
  const hasResearchWorkflow = matchedBoundary.includes('research');
  const hasMemoryAgentOps = matchedBoundary.some(boundary => [
    'persistent_memory', 'multi_tool', 'workflow_automation', 'messaging_gateway', 'skill_runtime', 'mcp',
  ].includes(boundary));

  let primaryIntent: TaskRouteIntent = 'general';
  if (inputContainsAny(userInput, CONVERSATION_TOKENS) && !requiresRepoMutation && !hasResearchWorkflow && !hasMemoryAgentOps && !hasTechnicalReasoning) {
    primaryIntent = 'conversation_or_control';
  } else if (requiresRepoMutation) {
    primaryIntent = 'repo_execution';
  } else if (hasMemoryAgentOps) {
    primaryIntent = 'memory_agent_ops';
  } else if (hasResearchWorkflow) {
    primaryIntent = 'research_workflow';
  } else if (hasTechnicalReasoning || hasNoMutation) {
    primaryIntent = 'technical_reasoning';
  }

  if (primaryIntent === 'technical_reasoning' && matchScore(userInput, 'research') && matchScore(userInput, 'deepseek_reasoning')) {
    matchedBoundary.push('technical_research_with_deepseek');
  }

  const riskyAction = inputContainsAny(userInput, ['删除', 'drop table', '生产', '线上', 'force push', 'rm -rf', '高风险']);

  return {
    primaryIntent,
    matchedBoundary: unique(matchedBoundary),
    requiresRepoMutation,
    explicitExecutorName,
    riskyAction,
  };
}

function ownershipExecutorForIntent(intent: TaskRouteIntent): string | null {
  if (intent === 'repo_execution') return 'codex-cli';
  if (intent === 'research_workflow') return 'pi-agent';
  return null;
}

function intentAffinity(profile: ExecutorProfile, intent: TaskRouteIntent): number {
  const configured = profile.intentAffinity?.[intent];
  if (typeof configured === 'number') return clampScore(configured);
  return DEFAULT_INTENT_AFFINITY[profile.name]?.[intent] ?? (intent === 'general' ? 0.35 : 0.25);
}

function profileMatchesUseCase(profile: ExecutorProfile, userInput: string, useCases: string[] | undefined): string[] {
  return (useCases ?? []).filter(useCase => inputContainsAny(userInput, [useCase]));
}

function buildRejectedCandidates(
  candidates: ExecutorRouteCandidate[],
  selectedExecutor: string,
  classification: IntentClassification,
): ExecutorRouteRejectedCandidate[] {
  return candidates
    .filter(candidate => candidate.executorName !== selectedExecutor)
    .map(candidate => {
      const affinity = candidate.primaryIntent ? intentAffinityForCandidate(candidate) : 0;
      let reason = 'lower intent-aware score';
      if (classification.primaryIntent === 'repo_execution' && (candidate.executorName === 'hermes-agent' || candidate.executorName === 'pi-agent')) {
        reason = 'task requires deterministic repo mutation';
      } else if ((classification.primaryIntent === 'research_workflow' || classification.primaryIntent === 'memory_agent_ops') && candidate.executorName === 'codex-cli') {
        reason = 'task is research, memory, tool orchestration, or gateway workflow rather than repo mutation';
      } else if (classification.primaryIntent === 'research_workflow' && candidate.executorName === 'hermes-agent') {
        reason = 'research workflow can race Pi Agent and Hermes Agent; lower primary score';
      } else if (classification.primaryIntent === 'technical_reasoning' && (candidate.executorName === 'hermes-agent' || candidate.executorName === 'pi-agent')) {
        reason = 'no multi-tool research, memory, or gateway requirement';
      } else if (classification.primaryIntent === 'technical_reasoning' && candidate.executorName === 'codex-cli') {
        reason = classification.requiresRepoMutation ? 'repo mutation owned by selected executor' : 'task does not require deterministic repo mutation';
      } else if (affinity < 0.4) {
        reason = `weak affinity for ${classification.primaryIntent}`;
      }
      return { executorName: candidate.executorName, reason, score: candidate.score };
    });
}

function intentAffinityForCandidate(candidate: ExecutorRouteCandidate): number {
  if (!candidate.reason.includes('intent_affinity=')) return 0;
  const match = candidate.reason.match(/intent_affinity=([0-9.]+)/);
  return match ? Number.parseFloat(match[1] ?? '0') : 0;
}

export class ExecutorRouter {
  constructor(private profiles: ExecutorProfile[]) {}

  route(input: { userInput: string; defaultExecutorName: string; explicitExecutorName?: string }): ExecutorRouteDecision {
    const availableProfiles = this.profiles.filter(profile => profile.availability === 'available');
    const classification = classifyIntent(input.userInput, availableProfiles);
    const explicitExecutorName = input.explicitExecutorName ?? classification.explicitExecutorName;
    const explicitProfile = explicitExecutorName
      ? availableProfiles.find(profile => profile.name === explicitExecutorName)
      : null;

    if (explicitExecutorName && (explicitProfile || input.explicitExecutorName)) {
      const selectedExecutor = explicitProfile?.name ?? explicitExecutorName;
      const candidate: ExecutorRouteCandidate = {
        executorName: selectedExecutor,
        score: 1,
        reason: 'explicit_executor_override',
        primaryIntent: classification.primaryIntent,
        matchedBoundary: classification.matchedBoundary,
      };
      return {
        selectedExecutor,
        action: 'auto_dispatch',
        confidence: 1,
        candidates: [candidate],
        reason: `用户显式指定 executor, intent=${classification.primaryIntent}, boundary=${classification.matchedBoundary.join('+') || '-'}`,
        primaryIntent: classification.primaryIntent,
        matchedBoundary: classification.matchedBoundary,
        rejected: buildRejectedCandidates(
          availableProfiles.map(profile => ({
            executorName: profile.name,
            score: profile.name === selectedExecutor ? 1 : 0,
            reason: profile.name === selectedExecutor ? 'explicit_executor_override' : 'rejected_by_explicit_executor_override',
            primaryIntent: classification.primaryIntent,
            matchedBoundary: classification.matchedBoundary,
          })),
          selectedExecutor,
          classification,
        ),
      };
    }

    if (classification.primaryIntent === 'conversation_or_control') {
      return this.fallbackDecision(input.defaultExecutorName, classification, [], 'conversation_or_control 不派发 executor');
    }

    const candidates = availableProfiles
      .map(profile => this.scoreProfile(profile, input.userInput, classification))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return right.reason.split(', ').length - left.reason.split(', ').length;
      });

    const selected = this.applyHardRules(candidates, input.defaultExecutorName, classification) ?? candidates[0];
    if (!selected || selected.score < 0.45) {
      return this.fallbackDecision(
        input.defaultExecutorName,
        classification,
        candidates,
        '没有足够高置信的 executor 匹配，回退默认 executor',
      );
    }

    const profile = availableProfiles.find(item => item.name === selected.executorName);
    const action: ExecutorRouteAction = profile?.riskLevel === 'high'
      ? 'fallback_default'
      : 'auto_dispatch';

    return {
      selectedExecutor: selected.executorName,
      action,
      confidence: selected.score,
      candidates,
      reason: selected.reason,
      primaryIntent: classification.primaryIntent,
      matchedBoundary: selected.matchedBoundary ?? classification.matchedBoundary,
      rejected: buildRejectedCandidates(candidates, selected.executorName, classification),
    };
  }

  private fallbackDecision(
    defaultExecutorName: string,
    classification: IntentClassification,
    candidates: ExecutorRouteCandidate[],
    reason: string,
  ): ExecutorRouteDecision {
    return {
      selectedExecutor: defaultExecutorName,
      action: 'fallback_default',
      confidence: candidates[0]?.score ?? 0,
      candidates,
      reason,
      primaryIntent: classification.primaryIntent,
      matchedBoundary: classification.matchedBoundary,
      rejected: buildRejectedCandidates(candidates, defaultExecutorName, classification),
    };
  }

  private applyHardRules(
    candidates: ExecutorRouteCandidate[],
    defaultExecutorName: string,
    classification: IntentClassification,
  ): ExecutorRouteCandidate | null {
    if (classification.primaryIntent === 'repo_execution') {
      return candidates.find(candidate => candidate.executorName === 'codex-cli')
        ?? candidates.find(candidate => candidate.executorName === defaultExecutorName)
        ?? null;
    }

    if (classification.primaryIntent === 'research_workflow') {
      return candidates.find(candidate => candidate.executorName === 'pi-agent') ?? null;
    }

    if (classification.primaryIntent === 'memory_agent_ops') {
      return candidates.find(candidate => candidate.executorName === 'pi-agent')
        ?? candidates.find(candidate => candidate.executorName === 'codex-cli')
        ?? null;
    }

    if (classification.primaryIntent === 'technical_reasoning') {
      const asksDeepSeek = classification.matchedBoundary.includes('deepseek_reasoning');
      const algorithmicOrChinese = classification.matchedBoundary.some(boundary =>
        ['algorithm', 'math', 'chinese_analysis', 'reasoning', 'technical_research_with_deepseek'].includes(boundary)
      );
      const codeReviewAlgorithmic = classification.matchedBoundary.includes('code_review') && algorithmicOrChinese;
      if (asksDeepSeek || algorithmicOrChinese || codeReviewAlgorithmic) {
        return candidates.find(candidate => candidate.executorName === 'deepseek-tui') ?? null;
      }
    }

    return null;
  }

  private scoreProfile(
    profile: ExecutorProfile,
    userInput: string,
    classification: IntentClassification,
  ): ExecutorRouteCandidate {
    let score = 0;
    const reasons: string[] = [];
    const matchedBoundary = [...classification.matchedBoundary];
    const affinity = intentAffinity(profile, classification.primaryIntent);
    score += affinity * 0.45;
    reasons.push(`intent=${classification.primaryIntent}`);
    reasons.push(`intent_affinity=${affinity.toFixed(2)}`);

    const owner = ownershipExecutorForIntent(classification.primaryIntent);
    if (owner && profile.name === owner) {
      score += 0.25;
      reasons.push(`ownership=${classification.primaryIntent}`);
    } else if (owner && profile.name !== owner) {
      score -= 0.2;
      reasons.push(`ownership_mismatch=${classification.primaryIntent}`);
    }

    if (classification.primaryIntent === 'technical_reasoning' && profile.name === 'deepseek-tui') {
      const hasDeepSeekBoundary = classification.matchedBoundary.some(boundary =>
        ['deepseek_reasoning', 'algorithm', 'math', 'chinese_analysis', 'reasoning'].includes(boundary)
      );
      if (hasDeepSeekBoundary) {
        score += 0.25;
        reasons.push('ownership=deepseek_reasoning');
      }
    }

    for (const domain of profile.domains) {
      if (matchScore(userInput, domain)) {
        score += SPECIALIZED_TOKENS.has(domain) ? 0.11 : 0.08;
        reasons.push(`domain=${domain}`);
        matchedBoundary.push(domain);
      }
    }

    for (const capability of profile.capabilities) {
      if (matchScore(userInput, capability)) {
        score += SPECIALIZED_TOKENS.has(capability) ? 0.1 : 0.07;
        reasons.push(`capability=${capability}`);
        matchedBoundary.push(capability);
      }
    }

    const primaryMatches = profileMatchesUseCase(profile, userInput, profile.primaryUseCases);
    if (primaryMatches.length > 0) {
      score += Math.min(0.18, primaryMatches.length * 0.08);
      reasons.push(`primary_use_case=${primaryMatches.join('|')}`);
    }

    const avoidMatches = profileMatchesUseCase(profile, userInput, profile.avoidUseCases);
    if (avoidMatches.length > 0) {
      score -= Math.min(0.25, avoidMatches.length * 0.12);
      reasons.push(`avoid_use_case=${avoidMatches.join('|')}`);
    }

    if (classification.explicitExecutorName === profile.name) {
      score += 0.35;
      reasons.push('explicit_executor_match');
    }

    score += Math.max(0, Math.min(1, profile.historicalSuccess)) * 0.08;
    reasons.push(`historical=${profile.historicalSuccess.toFixed(2)}`);

    return {
      executorName: profile.name,
      score: clampScore(score),
      reason: reasons.length > 0 ? reasons.join(', ') : '历史成功率兜底',
      primaryIntent: classification.primaryIntent,
      matchedBoundary: unique(matchedBoundary),
    };
  }
}
