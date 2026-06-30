// Legacy executor selection module that scores profiles from intent; being replaced by ExecutionPolicy routing.
import { isCapabilityClass, type CapabilityClass } from './capability-class.js';

export type ExecutorRiskLevel = 'low' | 'medium' | 'high';
export type ExecutorAvailability = 'available' | 'unavailable';
export type ExecutorRouteAction = 'auto_dispatch' | 'ask_review' | 'fallback_default' | 'ask_clarification';
export type IntentDecisionKind =
  | 'direct_reply'
  | 'task_control'
  | 'durable_task'
  | 'executor_dispatch'
  | 'clarification';
export type IntentRouteAction = ExecutorRouteAction | 'none' | 'ask_clarification';
export type TaskRouteIntent =
  | 'repo_execution'
  | 'technical_reasoning'
  | 'research_workflow'
  | 'memory_agent_ops'
  | 'conversation_or_control'
  | 'general';

// Single source of truth for the TaskRouteIntent union, mirroring the
// CAPABILITY_CLASSES pattern in capability-class.ts. Adding a new intent means
// extending the union above and this array together; nothing else should
// re-enumerate the members.
export const TASK_ROUTE_INTENTS: readonly TaskRouteIntent[] = [
  'repo_execution',
  'technical_reasoning',
  'research_workflow',
  'memory_agent_ops',
  'conversation_or_control',
  'general',
] as const;

export function isTaskRouteIntent(value: unknown): value is TaskRouteIntent {
  return typeof value === 'string' && (TASK_ROUTE_INTENTS as readonly string[]).includes(value);
}

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

export interface IntentDecision {
  intent: IntentDecisionKind;
  confidence: number;
  needsClarification: boolean;
  needsLongRunningTask: boolean;
  requiresLocalRepo: boolean;
  requiresResearch: boolean;
  requiresMultiTool: boolean;
  requiresLongTermMemory: boolean;
  requiresExternalGateway: boolean;
  canModifyFiles: boolean;
  shouldCreateDurableTask: boolean;
  reason: string;
  route: {
    target: string;
    action: IntentRouteAction;
    primaryIntent: TaskRouteIntent;
    // This field is a TaskRouteIntent (the legacy "route intent"), NOT a
    // CapabilityClass despite the historical name drift. It carries the intent
    // the router scored against; derive a CapabilityClass via
    // capabilityClassFromTaskRouteIntent when one is genuinely needed.
    routeIntent: TaskRouteIntent;
    requiredCapabilities: string[];
    matchedBoundary: string[];
    riskLevel: ExecutorRiskLevel;
    taskId?: string | null;
  };
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

const FALLBACK_EXECUTORS_BY_INTENT: Record<TaskRouteIntent, string[]> = {
  repo_execution: ['codex-cli', 'claude-code', 'deepseek-tui'],
  technical_reasoning: ['deepseek-tui', 'claude-code', 'codex-cli'],
  research_workflow: ['pi-agent', 'hermes-agent'],
  memory_agent_ops: ['hermes-agent', 'pi-agent'],
  conversation_or_control: [],
  general: [],
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

export function taskRouteIntentFromCapabilityClass(capabilityClass: CapabilityClass): TaskRouteIntent {
  if (capabilityClass === 'code_edit') return 'repo_execution';
  if (capabilityClass === 'research') return 'research_workflow';
  if (capabilityClass === 'messaging' || capabilityClass === 'memory_ops' || capabilityClass === 'office_automation') {
    return 'memory_agent_ops';
  }
  if (capabilityClass === 'conversation') return 'conversation_or_control';
  return 'general';
}

export function capabilityClassFromTaskRouteIntent(value: unknown): CapabilityClass | null {
  // technical_reasoning is a read-only analysis intent, not a capability boundary
  // — reasoning is orthogonal to tool/side-effect class, and forcing it to code_edit
  // would wrongly impose repo-mutation isolation + test verification on read-only
  // analysis (see buildLegacyIntentDecision's "不改文件" branch). It has no
  // CapabilityClass, so callers fall back to their interaction-type default.
  if (value === 'repo_execution') return 'code_edit';
  if (value === 'research_workflow') return 'research';
  if (value === 'memory_agent_ops') return 'memory_ops';
  if (value === 'conversation_or_control') return 'conversation';
  if (value === 'general') return 'general';
  return null;
}

export function normalizeTaskRouteIntent(value: unknown): TaskRouteIntent {
  if (isTaskRouteIntent(value)) {
    return value;
  }

  return isCapabilityClass(value)
    ? taskRouteIntentFromCapabilityClass(value)
    : 'general';
}

// Derives capability flags from a TaskRouteIntent, so the intent->flag mapping
// lives in one place rather than as scattered === checks at each decision
// builder. Keep in sync with taskRouteIntentFromCapabilityClass.
interface IntentCapabilityFlags {
  requiresLocalRepo: boolean;
  requiresResearch: boolean;
  requiresMultiTool: boolean;
  requiresLongTermMemory: boolean;
  canModifyFiles: boolean;
}

export function intentCapabilityFlags(intent: TaskRouteIntent): IntentCapabilityFlags {
  return {
    requiresLocalRepo: intent === 'repo_execution',
    requiresResearch: intent === 'research_workflow',
    requiresMultiTool: intent === 'memory_agent_ops',
    requiresLongTermMemory: intent === 'memory_agent_ops',
    canModifyFiles: intent === 'repo_execution',
  };
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, score));
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

function normalizeRisk(value: ExecutorRiskLevel): number {
  if (value === 'high') return 3;
  if (value === 'medium') return 2;
  return 1;
}

function normalizeDecision(decision: IntentDecision): IntentDecision {
  return {
    ...decision,
    confidence: clampScore(decision.confidence),
    route: {
      ...decision.route,
      requiredCapabilities: unique(decision.route.requiredCapabilities ?? []),
      matchedBoundary: unique(decision.route.matchedBoundary ?? []),
    },
  };
}

function routeActionToExecutorAction(action: IntentRouteAction): ExecutorRouteAction {
  if (action === 'ask_review') return 'ask_review';
  if (action === 'fallback_default') return 'fallback_default';
  if (action === 'ask_clarification' || action === 'none') return 'ask_clarification';
  return 'auto_dispatch';
}

function intentAffinity(profile: ExecutorProfile, intent: TaskRouteIntent): number {
  const configured = profile.intentAffinity?.[intent];
  if (typeof configured === 'number') return clampScore(configured);
  return DEFAULT_INTENT_AFFINITY[profile.name]?.[intent] ?? (intent === 'general' ? 0.35 : 0.25);
}

function hasCapabilityOverlap(profile: ExecutorProfile, requiredCapabilities: string[]): string[] {
  const profileCapabilities = new Set([
    ...profile.capabilities,
    ...profile.domains,
    ...profile.outputTypes,
    ...profile.inputTypes,
  ]);
  return requiredCapabilities.filter(capability => profileCapabilities.has(capability));
}

function candidateReason(parts: string[]): string {
  return parts.length > 0 ? parts.join(', ') : 'semantic_decision_fallback';
}

function buildRejectedCandidates(
  candidates: ExecutorRouteCandidate[],
  selectedExecutor: string,
): ExecutorRouteRejectedCandidate[] {
  return candidates
    .filter(candidate => candidate.executorName !== selectedExecutor)
    .map(candidate => ({
      executorName: candidate.executorName,
      score: candidate.score,
      reason: candidate.reason || 'lower semantic decision score',
    }));
}

export function buildFallbackIntentDecision(input: {
  target: string;
  action?: IntentRouteAction;
  primaryIntent?: TaskRouteIntent;
  routeIntent?: TaskRouteIntent;
  requiredCapabilities?: string[];
  matchedBoundary?: string[];
  confidence?: number;
  reason: string;
  riskLevel?: ExecutorRiskLevel;
  needsLongRunningTask?: boolean;
  requiresLocalRepo?: boolean;
  requiresResearch?: boolean;
  requiresMultiTool?: boolean;
  requiresLongTermMemory?: boolean;
  requiresExternalGateway?: boolean;
  canModifyFiles?: boolean;
  shouldCreateDurableTask?: boolean;
}): IntentDecision {
  const primaryIntent = input.primaryIntent ?? input.routeIntent ?? 'general';
  const routeIntent = input.routeIntent ?? primaryIntent;
  const action = input.action ?? 'auto_dispatch';
  const flags = intentCapabilityFlags(routeIntent);
  return {
    intent: action === 'ask_clarification' ? 'clarification' : 'executor_dispatch',
    confidence: input.confidence ?? 0.45,
    needsClarification: action === 'ask_clarification',
    needsLongRunningTask: input.needsLongRunningTask ?? false,
    requiresLocalRepo: input.requiresLocalRepo ?? flags.requiresLocalRepo,
    requiresResearch: input.requiresResearch ?? flags.requiresResearch,
    requiresMultiTool: input.requiresMultiTool ?? flags.requiresMultiTool,
    requiresLongTermMemory: input.requiresLongTermMemory ?? flags.requiresLongTermMemory,
    requiresExternalGateway: input.requiresExternalGateway ?? false,
    canModifyFiles: input.canModifyFiles ?? flags.canModifyFiles,
    shouldCreateDurableTask: input.shouldCreateDurableTask ?? false,
    reason: input.reason,
    route: {
      target: input.target,
      action,
      primaryIntent,
      routeIntent,
      requiredCapabilities: input.requiredCapabilities ?? [],
      matchedBoundary: input.matchedBoundary ?? [],
      riskLevel: input.riskLevel ?? 'medium',
    },
  };
}

export class ExecutorRouter {
  constructor(private readonly defaultProfiles: ExecutorProfile[] = []) {}

  route(input: {
    decision: IntentDecision;
    profiles?: ExecutorProfile[];
    defaultExecutorName: string;
  } | {
    userInput: string;
    profiles?: ExecutorProfile[];
    defaultExecutorName: string;
  }): ExecutorRouteDecision {
    if ('userInput' in input) {
      const profiles = input.profiles ?? this.defaultProfiles;
      return this.route({
        decision: this.buildLegacyIntentDecision(input.userInput, profiles, input.defaultExecutorName),
        profiles,
        defaultExecutorName: input.defaultExecutorName,
      });
    }

    const decision = normalizeDecision(input.decision);
    const profiles = (input.profiles ?? this.defaultProfiles).filter(profile => profile.availability === 'available');

    if (
      decision.intent === 'direct_reply'
      || decision.intent === 'task_control'
      || decision.intent === 'clarification'
      || decision.route.target === 'metaclaw'
    ) {
      return this.nonDispatchDecision(input.defaultExecutorName, decision, 'semantic decision stays inside MetaClaw');
    }

    const directProfile = profiles.find(profile => profile.name === decision.route.target);
    if (directProfile) {
      const candidate = this.directCandidate(directProfile, decision);
      return this.buildDecision(candidate, profiles, decision, 'target_available');
    }

    const candidates = profiles
      .map(profile => this.scoreFallbackProfile(profile, decision, input.defaultExecutorName))
      .sort((left, right) => right.score - left.score);
    const selected = candidates[0];

    if (!selected || selected.score < 0.35) {
      return this.askClarificationDecision(
        input.defaultExecutorName,
        decision,
        candidates,
        `target ${decision.route.target} unavailable and no compatible fallback found; ask before dispatch`,
      );
    }

    return this.buildDecision(selected, profiles, decision, `target ${decision.route.target} unavailable; semantic fallback selected`);
  }

  private buildLegacyIntentDecision(
    userInput: string,
    profiles: ExecutorProfile[],
    defaultExecutorName: string,
  ): IntentDecision {
    const text = userInput.toLowerCase();
    const contains = (patterns: RegExp[]) => patterns.some(pattern => pattern.test(userInput) || pattern.test(text));
    const findProfile = (names: string[]) => names.find(name => profiles.some(profile => profile.name === name && profile.availability === 'available'));

    const legalProfile = profiles.find(profile =>
      profile.availability === 'available'
      && [...profile.domains, ...profile.capabilities].some(item => /legal|contract|合同|法务|risk_matrix/.test(item))
      && /合同|条款|法务|legal|contract|风险矩阵/i.test(userInput)
    );
    if (legalProfile) {
      return buildFallbackIntentDecision({
        target: legalProfile.name,
        action: 'auto_dispatch',
        primaryIntent: 'general',
        routeIntent: 'general',
        requiredCapabilities: legalProfile.capabilities,
        matchedBoundary: ['legal', 'contract_review'],
        confidence: 0.78,
        reason: 'legacy route preview matched legal/contract profile',
        riskLevel: legalProfile.riskLevel,
      });
    }

    const requiresMessagingGateway = contains([/消息网关/u, /通知客户/u, /发送给客户/u, /messaging gateway/i]);
    if (requiresMessagingGateway) {
      return buildFallbackIntentDecision({
        target: defaultExecutorName,
        action: 'ask_clarification',
        primaryIntent: 'memory_agent_ops',
        routeIntent: 'memory_agent_ops',
        requiredCapabilities: ['messaging_gateway'],
        matchedBoundary: ['messaging_gateway', 'external_action'],
        confidence: 0.62,
        reason: 'legacy route preview detected external messaging gateway work',
        riskLevel: 'high',
      });
    }

    const requiresRepoMutation = contains([/修复/u, /实现/u, /修改/u, /代码/u, /补丁/u, /\bbug\b/i, /\btest(s)?\b/i, /\bpatch\b/i, /\brepo\b/i, /PR review/i]);
    const requiresTechnicalReasoning = contains([/DeepSeek/i, /算法/u, /数学/u, /推理/u, /边界条件/u, /中文技术分析/u])
      || (/分析这段代码/u.test(userInput) && /不改文件/u.test(userInput))
      || (/代码 review/i.test(userInput) && /算法正确性/u.test(userInput));
    const requiresMemoryOps = contains([/长期记忆/u, /多工具/u, /自动化/u, /multi[- ]?tool/i, /memory/i]);
    const requiresResearch = contains([/调研/u, /研究/u, /市场/u, /报告/u, /趋势/u, /\bresearch\b/i]);
    const requiresArchitecture = contains([/架构/u, /长上下文/u, /系统设计/u, /large[- ]?context/i]);

    if (requiresArchitecture) {
      const target = findProfile(['claude-code']) ?? defaultExecutorName;
      return buildFallbackIntentDecision({
        target,
        action: 'auto_dispatch',
        primaryIntent: 'technical_reasoning',
        routeIntent: 'technical_reasoning',
        requiredCapabilities: ['architecture_review', 'long_context_analysis'],
        matchedBoundary: ['architecture', 'long_context'],
        confidence: 0.76,
        reason: 'legacy route preview detected architecture/large-context work',
      });
    }

    if (requiresTechnicalReasoning) {
      const target = findProfile(['deepseek-tui']) ?? defaultExecutorName;
      return buildFallbackIntentDecision({
        target,
        action: 'auto_dispatch',
        primaryIntent: 'technical_reasoning',
        routeIntent: 'technical_reasoning',
        requiredCapabilities: ['deepseek_reasoning', 'algorithm', 'code_review'],
        matchedBoundary: ['reasoning', 'algorithm', 'chinese_analysis'],
        confidence: 0.78,
        reason: 'legacy route preview detected reasoning/algorithm work',
        canModifyFiles: !/不改文件/u.test(userInput),
      });
    }

    if (requiresMemoryOps) {
      const target = requiresResearch
        ? findProfile(['pi-agent', 'hermes-agent']) ?? defaultExecutorName
        : findProfile(['hermes-agent', 'pi-agent']) ?? defaultExecutorName;
      return buildFallbackIntentDecision({
        target,
        action: 'auto_dispatch',
        primaryIntent: 'memory_agent_ops',
        routeIntent: 'memory_agent_ops',
        requiredCapabilities: ['persistent_memory', 'multi_tool', 'workflow_automation'],
        matchedBoundary: ['memory', 'multi_tool', 'workflow_automation'],
        confidence: 0.74,
        reason: 'legacy route preview detected memory/multi-tool agent work',
      });
    }

    if (requiresResearch) {
      const target = findProfile(['pi-agent', 'hermes-agent']) ?? defaultExecutorName;
      return buildFallbackIntentDecision({
        target,
        action: 'auto_dispatch',
        primaryIntent: 'research_workflow',
        routeIntent: 'research_workflow',
        requiredCapabilities: ['research', 'report_generation'],
        matchedBoundary: ['research', 'report_generation'],
        confidence: 0.72,
        reason: 'legacy route preview detected research/report work',
      });
    }

    if (requiresRepoMutation) {
      return buildFallbackIntentDecision({
        target: defaultExecutorName,
        action: 'auto_dispatch',
        primaryIntent: 'repo_execution',
        routeIntent: 'repo_execution',
        requiredCapabilities: ['coding', 'tests', 'code_review'],
        matchedBoundary: ['repo_mutation'],
        confidence: 0.76,
        reason: 'legacy route preview detected repo mutation work',
        canModifyFiles: true,
      });
    }

    return buildFallbackIntentDecision({
      target: defaultExecutorName,
      action: 'fallback_default',
      primaryIntent: 'general',
      routeIntent: 'general',
      confidence: 0.45,
      reason: 'legacy route preview found no strong executor-specific signal',
    });
  }

  private nonDispatchDecision(
    defaultExecutorName: string,
    decision: IntentDecision,
    reason: string,
  ): ExecutorRouteDecision {
    return {
      selectedExecutor: defaultExecutorName,
      action: decision.intent === 'clarification' || decision.needsClarification
        ? 'ask_clarification'
        : 'fallback_default',
      confidence: decision.confidence,
      candidates: [],
      reason,
      primaryIntent: decision.route.primaryIntent,
      matchedBoundary: decision.route.matchedBoundary,
      rejected: [],
    };
  }

  private fallbackDecision(
    defaultExecutorName: string,
    decision: IntentDecision,
    candidates: ExecutorRouteCandidate[],
    reason: string,
  ): ExecutorRouteDecision {
    return {
      selectedExecutor: defaultExecutorName,
      action: 'fallback_default',
      confidence: candidates[0]?.score ?? 0,
      candidates,
      reason,
      primaryIntent: decision.route.primaryIntent,
      matchedBoundary: decision.route.matchedBoundary,
      rejected: buildRejectedCandidates(candidates, defaultExecutorName),
    };
  }

  private askClarificationDecision(
    defaultExecutorName: string,
    decision: IntentDecision,
    candidates: ExecutorRouteCandidate[],
    reason: string,
  ): ExecutorRouteDecision {
    return {
      selectedExecutor: defaultExecutorName,
      action: 'ask_clarification',
      confidence: candidates[0]?.score ?? decision.confidence,
      candidates,
      reason,
      primaryIntent: decision.route.primaryIntent,
      matchedBoundary: decision.route.matchedBoundary,
      rejected: buildRejectedCandidates(candidates, defaultExecutorName),
    };
  }

  private buildDecision(
    selected: ExecutorRouteCandidate,
    profiles: ExecutorProfile[],
    decision: IntentDecision,
    reasonPrefix: string,
  ): ExecutorRouteDecision {
    const candidates = this.ensureCandidateList(selected, profiles, decision);
    const selectedProfile = profiles.find(profile => profile.name === selected.executorName);
    const requestedAction = routeActionToExecutorAction(decision.route.action);
    const riskAction = selectedProfile?.riskLevel === 'high' || normalizeRisk(decision.route.riskLevel) >= 3
      ? 'ask_clarification'
      : requestedAction;
    const action = requestedAction === 'ask_review' ? 'ask_review' : riskAction;

    return {
      selectedExecutor: selected.executorName,
      action,
      confidence: selected.score,
      candidates,
      reason: `${reasonPrefix}: ${selected.reason}`,
      primaryIntent: decision.route.primaryIntent,
      matchedBoundary: selected.matchedBoundary ?? decision.route.matchedBoundary,
      rejected: buildRejectedCandidates(candidates, selected.executorName),
    };
  }

  private ensureCandidateList(
    selected: ExecutorRouteCandidate,
    profiles: ExecutorProfile[],
    decision: IntentDecision,
  ): ExecutorRouteCandidate[] {
    const candidates = profiles.map(profile => this.scoreFallbackProfile(profile, decision, selected.executorName));
    if (!candidates.some(candidate => candidate.executorName === selected.executorName)) {
      candidates.push(selected);
    }
    return candidates.sort((left, right) => right.score - left.score);
  }

  private directCandidate(profile: ExecutorProfile, decision: IntentDecision): ExecutorRouteCandidate {
    const overlap = hasCapabilityOverlap(profile, decision.route.requiredCapabilities);
    const score = clampScore(Math.max(decision.confidence, 0.8) + overlap.length * 0.03);
    return {
      executorName: profile.name,
      score,
      reason: candidateReason([
        'decision_target_available',
        `intent=${decision.route.primaryIntent}`,
        overlap.length > 0 ? `capability_overlap=${overlap.join('|')}` : '',
      ].filter(Boolean)),
      primaryIntent: decision.route.primaryIntent,
      matchedBoundary: decision.route.matchedBoundary,
    };
  }

  private scoreFallbackProfile(
    profile: ExecutorProfile,
    decision: IntentDecision,
    defaultExecutorName: string,
  ): ExecutorRouteCandidate {
    let score = 0;
    const reasons: string[] = [];
    const routeIntent = decision.route.routeIntent;
    const fallbackRank = FALLBACK_EXECUTORS_BY_INTENT[routeIntent].indexOf(profile.name);
    const affinity = intentAffinity(profile, routeIntent);
    const capabilityOverlap = hasCapabilityOverlap(profile, decision.route.requiredCapabilities);

    score += affinity * 0.4;
    reasons.push(`intent=${routeIntent}`);
    reasons.push(`intent_affinity=${affinity.toFixed(2)}`);

    if (fallbackRank >= 0) {
      score += Math.max(0.05, 0.3 - fallbackRank * 0.07);
      reasons.push(`same_class_fallback_rank=${fallbackRank + 1}`);
    }

    if (capabilityOverlap.length > 0) {
      score += Math.min(0.25, capabilityOverlap.length * 0.08);
      reasons.push(`capability_overlap=${capabilityOverlap.join('|')}`);
    }

    if (profile.name === defaultExecutorName) {
      score += 0.08;
      reasons.push('default_executor');
    }

    if (normalizeRisk(profile.riskLevel) > normalizeRisk(decision.route.riskLevel)) {
      score -= 0.12;
      reasons.push('risk_above_decision');
    }

    if (
      decision.route.matchedBoundary.includes('repo_mutation')
      && profile.name !== defaultExecutorName
      && intentAffinity(profile, 'repo_execution') < 0.35
    ) {
      score -= 0.2;
      reasons.push('repo mutation ownership mismatch');
    }

    return {
      executorName: profile.name,
      score: clampScore(score),
      reason: candidateReason(reasons),
      primaryIntent: decision.route.primaryIntent,
      matchedBoundary: decision.route.matchedBoundary,
    };
  }
}
