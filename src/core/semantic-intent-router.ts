import type { LlmBridge, TaskSummary } from './llm-bridge.js';
import type { RuleHint } from './rule-hints-provider.js';
import {
  ExecutorRouter,
  buildFallbackIntentDecision,
  type IntentDecision,
  type ExecutorProfile,
  type ExecutorRouteAction,
  type ExecutorRouteCandidate,
  type ExecutorRouteDecision,
  type ExecutorRouteRejectedCandidate,
  type TaskRouteIntent,
} from './executor-router.js';
import type { TaskClearScope, TaskStatusQueryScope } from './task-routing.js';

export type SemanticInteractionType =
  | 'direct_reply'
  | 'task_control'
  | 'durable_task'
  | 'executor_dispatch'
  | 'clarification';

export type SemanticRiskLevel = 'low' | 'medium' | 'high';

export interface SemanticTaskBinding {
  type: 'new' | 'reference' | 'none';
  taskId: string | null;
  reason: string;
}

export interface SemanticTaskControl {
  kind:
    | 'clear_tasks'
    | 'status_query'
    | 'resume_task'
    | 'recover_blocked'
    | 'last_task_continuation'
    | 'unknown';
  taskId: string | null;
  scope: TaskClearScope | TaskStatusQueryScope | null;
  reason: string;
}

export interface SemanticIntentDecision {
  interactionType: SemanticInteractionType;
  confidence: number;
  shouldAskBeforeActing: boolean;
  ambiguity: string[];
  risk: SemanticRiskLevel;
  reason: string;
  clarificationQuestion: string | null;
  taskBinding: SemanticTaskBinding;
  taskControl: SemanticTaskControl | null;
  executorDecision: ExecutorRouteDecision | null;
  fallback: boolean;
}

interface SemanticIntentRouterOptions {
  defaultExecutorName: string;
  llmTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const HIGH_CONFIDENCE = 0.78;
const LOW_CONFIDENCE = 0.55;

const INTERACTION_TYPES = new Set<SemanticInteractionType>([
  'direct_reply',
  'task_control',
  'durable_task',
  'executor_dispatch',
  'clarification',
]);

const RISK_LEVELS = new Set<SemanticRiskLevel>(['low', 'medium', 'high']);
const ROUTE_ACTIONS = new Set<ExecutorRouteAction>([
  'auto_dispatch',
  'ask_review',
  'fallback_default',
  'race_executors',
]);

function clampConfidence(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('semantic intent router returned non-JSON output');
    }
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

function hasTask(tasks: TaskSummary[], taskId: string | null): boolean {
  return Boolean(taskId && tasks.some(task => task.id === taskId));
}

function conservativeFallback(reason: string): SemanticIntentDecision {
  return {
    interactionType: 'direct_reply',
    confidence: 0.5,
    shouldAskBeforeActing: false,
    ambiguity: [],
    risk: 'low',
    reason,
    clarificationQuestion: null,
    taskBinding: {
      type: 'none',
      taskId: null,
      reason,
    },
    taskControl: null,
    executorDecision: null,
    fallback: true,
  };
}

export class SemanticIntentRouter {
  constructor(
    private llmBridge: LlmBridge,
    private executorProfiles: ExecutorProfile[],
    private options: SemanticIntentRouterOptions,
  ) {}

  async decide(userInput: string, recentTasks: TaskSummary[], hints: RuleHint[] = []): Promise<SemanticIntentDecision> {
    const hintDecision = this.decideTaskControlFromParserHints(hints, recentTasks);
    if (hintDecision) {
      return this.validateDecision(hintDecision);
    }
    const conversationHintDecision = this.decideConversationFromHints(hints);
    if (conversationHintDecision) {
      return this.validateDecision(conversationHintDecision);
    }

    if (typeof this.llmBridge.query !== 'function') {
      return this.decideWithLegacyLlmBridge(userInput, recentTasks, hints);
    }

    try {
      const raw = await this.awaitWithTimeout(
        this.llmBridge.query(this.buildPrompt(userInput, recentTasks)),
        this.options.llmTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      return this.validateDecision(this.normalizeDecision(parseJsonObject(raw), recentTasks));
    } catch {
      return conservativeFallback('Codex CLI 语义路由失败，保守降级为普通对话');
    }
  }

  private async decideWithLegacyLlmBridge(
    userInput: string,
    recentTasks: TaskSummary[],
    hints: RuleHint[],
  ): Promise<SemanticIntentDecision> {
    if (typeof this.llmBridge.resolveTaskStateOwnership === 'function') {
      const ownership = await this.llmBridge.resolveTaskStateOwnership(userInput, recentTasks);
      if (ownership.owner === 'metaclaw' && ownership.confidence >= 0.55) {
        return this.validateDecision({
          interactionType: 'task_control',
          confidence: ownership.confidence,
          shouldAskBeforeActing: false,
          ambiguity: [],
          risk: 'low',
          reason: ownership.reason,
          clarificationQuestion: null,
          taskBinding: {
            type: ownership.taskId ? 'reference' : 'none',
            taskId: ownership.taskId,
            reason: ownership.reason,
          },
          taskControl: {
            kind: 'status_query',
            taskId: ownership.taskId,
            scope: ownership.scope ?? 'dashboard',
            reason: ownership.reason,
          },
          executorDecision: null,
          fallback: false,
        });
      }
    }

    try {
      const routeDecision = typeof this.llmBridge.resolveRoute === 'function'
        ? await this.llmBridge.resolveRoute(userInput, recentTasks)
        : { route: 'durable_task' as const, confidence: 0.78, reason: '缺少 resolveRoute，legacy adapter 按 durable task 兼容处理' };
      const legacyHintDecision = this.decideTaskControlFromParserHints(hints, recentTasks);
      if (legacyHintDecision) {
        return this.validateDecision(legacyHintDecision);
      }
      const conversationHintDecision = this.decideConversationFromHints(hints);
      if (conversationHintDecision) {
        return this.validateDecision(conversationHintDecision);
      }
      if (routeDecision.route === 'conversation' || routeDecision.route === 'unknown') {
        return conservativeFallback(routeDecision.reason || '旧版 LLM 路由未给出可执行动作');
      }

      const intent = typeof this.llmBridge.resolveIntent === 'function'
        ? await this.llmBridge.resolveIntent(userInput, recentTasks)
        : { type: 'new' as const, taskId: null, reason: '缺少 resolveIntent，按新任务处理' };
      const executorDecision = routeDecision.route === 'durable_task'
        ? new ExecutorRouter(this.executorProfiles).route({
            userInput,
            defaultExecutorName: this.options.defaultExecutorName,
          })
        : null;

      return this.validateDecision({
        interactionType: routeDecision.route === 'task_control' ? 'task_control' : 'durable_task',
        confidence: 0.78,
        shouldAskBeforeActing: false,
        ambiguity: [],
        risk: 'low',
        reason: routeDecision.reason,
        clarificationQuestion: null,
        taskBinding: {
          type: intent.type,
          taskId: intent.taskId,
          reason: intent.reason,
        },
        taskControl: routeDecision.route === 'task_control'
          ? {
              kind: 'unknown',
              taskId: intent.taskId,
              scope: null,
              reason: routeDecision.reason,
            }
          : null,
        executorDecision,
        fallback: false,
      });
    } catch {
      return conservativeFallback('旧版 LLM 路由失败，保守降级为普通对话');
    }
  }

  private decideTaskControlFromParserHints(hints: RuleHint[], recentTasks: TaskSummary[]): SemanticIntentDecision | null {
    const clearHint = hints.find(hint => hint.kind === 'clear_tasks' && hint.weight >= 0.9);
    if (clearHint) {
      return this.buildTaskControlDecision({
        kind: 'clear_tasks',
        taskId: null,
        scope: clearHint.evidence as TaskClearScope,
        confidence: clearHint.weight,
        reason: clearHint.reason,
      });
    }

    const statusHint = hints.find(hint => hint.kind === 'status_query' && hint.weight >= 0.7);
    if (statusHint) {
      return this.buildTaskControlDecision({
        kind: 'status_query',
        taskId: null,
        scope: statusHint.evidence as TaskStatusQueryScope,
        confidence: statusHint.weight,
        reason: statusHint.reason,
      });
    }

    const resumeHint = hints.find(hint => hint.kind === 'resume_task' && hint.weight >= 0.65);
    if (!resumeHint) {
      return null;
    }

    const explicitTaskId = resumeHint.evidence.match(/^task_[A-Za-z0-9_-]+$/)?.[0] ?? null;
    const control = resumeHint.evidence === 'recover_blocked'
      ? 'recover_blocked'
      : resumeHint.evidence === 'last_task_continuation'
        ? 'last_task_continuation'
        : 'resume_task';
    if (control === 'recover_blocked' && !recentTasks.some(task => task.status === 'blocked')) {
      return null;
    }

    return this.buildTaskControlDecision({
      kind: control,
      taskId: explicitTaskId,
      scope: explicitTaskId ? null : resumeHint.evidence as TaskClearScope | TaskStatusQueryScope,
      confidence: resumeHint.weight,
      reason: resumeHint.reason,
    });
  }

  private buildTaskControlDecision(input: {
    kind: SemanticTaskControl['kind'];
    taskId: string | null;
    scope: TaskClearScope | TaskStatusQueryScope | null;
    confidence: number;
    reason: string;
  }): SemanticIntentDecision {
    return {
      interactionType: 'task_control',
      confidence: Math.max(input.confidence, 0.9),
      shouldAskBeforeActing: false,
      ambiguity: [],
      risk: 'low',
      reason: input.reason,
      clarificationQuestion: null,
      taskBinding: {
        type: input.taskId ? 'reference' : 'none',
        taskId: input.taskId,
        reason: input.reason,
      },
      taskControl: {
        kind: input.kind,
        taskId: input.taskId,
        scope: input.scope,
        reason: input.reason,
      },
      executorDecision: null,
      fallback: false,
    };
  }

  private decideConversationFromHints(hints: RuleHint[]): SemanticIntentDecision | null {
    const continuationHint = hints.find(hint => hint.kind === 'conversation_continuation' && hint.weight >= 0.5);
    if (continuationHint) {
      return {
        interactionType: 'direct_reply',
        confidence: continuationHint.weight,
        shouldAskBeforeActing: false,
        ambiguity: [],
        risk: 'low',
        reason: '延续当前对话，不恢复旧任务',
        clarificationQuestion: null,
        taskBinding: {
          type: 'none',
          taskId: null,
          reason: continuationHint.reason,
        },
        taskControl: null,
        executorDecision: null,
        fallback: false,
      };
    }

    const derivedWorkHint = hints.find(hint => hint.kind === 'durable_work' && hint.reason.includes('conversation'));
    if (!derivedWorkHint) {
      return null;
    }

    return {
      interactionType: 'durable_task',
      confidence: Math.max(0.65, derivedWorkHint.weight),
      shouldAskBeforeActing: false,
      ambiguity: [],
      risk: 'low',
      reason: '按当前对话创建跟进任务',
      clarificationQuestion: null,
      taskBinding: {
        type: 'new',
        taskId: null,
        reason: derivedWorkHint.reason,
      },
      taskControl: null,
      executorDecision: {
        selectedExecutor: this.options.defaultExecutorName,
        action: 'auto_dispatch',
        confidence: Math.max(0.65, derivedWorkHint.weight),
        candidates: [
          {
            executorName: this.options.defaultExecutorName,
            score: Math.max(0.65, derivedWorkHint.weight),
            reason: derivedWorkHint.reason,
            primaryIntent: 'repo_execution',
            matchedBoundary: ['conversation_follow_up'],
          },
        ],
        reason: derivedWorkHint.reason,
        primaryIntent: 'repo_execution',
        matchedBoundary: ['conversation_follow_up'],
        rejected: [],
      },
      fallback: false,
    };
  }

  private normalizeDecision(raw: Record<string, unknown>, recentTasks: TaskSummary[]): SemanticIntentDecision {
    const interactionType = INTERACTION_TYPES.has(raw.interactionType as SemanticInteractionType)
      ? raw.interactionType as SemanticInteractionType
      : 'clarification';
    const confidence = clampConfidence(raw.confidence);
    const risk = RISK_LEVELS.has(raw.risk as SemanticRiskLevel)
      ? raw.risk as SemanticRiskLevel
      : 'medium';
    const rawTaskBinding = (raw.taskBinding ?? {}) as Record<string, unknown>;
    const taskBindingType = rawTaskBinding.type === 'reference' || rawTaskBinding.type === 'new'
      ? rawTaskBinding.type
      : 'none';
    const taskId = asString(rawTaskBinding.taskId, '') || null;
    const taskBinding: SemanticTaskBinding = {
      type: taskBindingType === 'reference' && !hasTask(recentTasks, taskId)
        ? 'none'
        : taskBindingType,
      taskId: taskBindingType === 'reference' && hasTask(recentTasks, taskId) ? taskId : null,
      reason: asString(rawTaskBinding.reason, ''),
    };

    const rawTaskControl = raw.taskControl && typeof raw.taskControl === 'object'
      ? raw.taskControl as Record<string, unknown>
      : null;
    const taskControl: SemanticTaskControl | null = rawTaskControl
      ? {
          kind: this.normalizeTaskControlKind(rawTaskControl.kind),
          taskId: asString(rawTaskControl.taskId, '') || taskBinding.taskId,
          scope: asString(rawTaskControl.scope, '') as TaskClearScope | TaskStatusQueryScope || null,
          reason: asString(rawTaskControl.reason, ''),
        }
      : null;

    const normalized: SemanticIntentDecision = {
      interactionType,
      confidence,
      shouldAskBeforeActing: raw.shouldAskBeforeActing === true,
      ambiguity: asStringArray(raw.ambiguity),
      risk,
      reason: asString(raw.reason, ''),
      clarificationQuestion: asString(raw.clarificationQuestion, '') || null,
      taskBinding,
      taskControl,
      executorDecision: this.normalizeExecutorDecision(raw.executorDecision, interactionType),
      fallback: false,
    };
    if (
      (interactionType === 'durable_task' || interactionType === 'executor_dispatch')
      && !normalized.executorDecision
    ) {
      const intentDecision = this.normalizeIntentDecision(raw.intentDecision, normalized);
      normalized.executorDecision = new ExecutorRouter(this.executorProfiles).route({
        decision: intentDecision,
        defaultExecutorName: this.options.defaultExecutorName,
      });
    }

    return normalized;
  }

  private normalizeTaskControlKind(value: unknown): SemanticTaskControl['kind'] {
    if (
      value === 'clear_tasks'
      || value === 'status_query'
      || value === 'resume_task'
      || value === 'recover_blocked'
      || value === 'last_task_continuation'
    ) {
      return value;
    }
    return 'unknown';
  }

  private normalizeExecutorDecision(raw: unknown, interactionType: SemanticInteractionType): ExecutorRouteDecision | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const value = raw as Record<string, unknown>;
    const action = ROUTE_ACTIONS.has(value.action as ExecutorRouteAction)
      ? value.action as ExecutorRouteAction
      : 'fallback_default';
    const selectedExecutor = asString(value.selectedExecutor, this.options.defaultExecutorName);
    const primaryIntent = this.normalizePrimaryIntent(value.primaryIntent);
    const candidates = this.normalizeCandidates(value.candidates, primaryIntent);
    const rejected = this.normalizeRejected(value.rejected);

    return {
      selectedExecutor,
      action: interactionType === 'executor_dispatch' ? action : action === 'race_executors' ? 'race_executors' : action,
      confidence: clampConfidence(value.confidence),
      candidates,
      reason: asString(value.reason, ''),
      primaryIntent,
      matchedBoundary: asStringArray(value.matchedBoundary),
      rejected,
    };
  }

  private normalizeIntentDecision(raw: unknown, decision: SemanticIntentDecision): IntentDecision {
    if (!raw || typeof raw !== 'object') {
      return buildFallbackIntentDecision({
        target: decision.executorDecision?.selectedExecutor ?? this.options.defaultExecutorName,
        action: decision.executorDecision?.action ?? 'auto_dispatch',
        primaryIntent: decision.executorDecision?.primaryIntent ?? 'general',
        capabilityClass: decision.executorDecision?.primaryIntent ?? 'general',
        matchedBoundary: decision.executorDecision?.matchedBoundary ?? [],
        confidence: decision.confidence,
        riskLevel: decision.risk === 'high' ? 'high' : decision.risk === 'medium' ? 'medium' : 'low',
        reason: decision.reason || 'semantic intent router fallback executor decision',
        needsLongRunningTask: decision.interactionType === 'durable_task',
        shouldCreateDurableTask: decision.taskBinding.type === 'new',
      });
    }

    const value = raw as Record<string, unknown>;
    const route = value.route && typeof value.route === 'object'
      ? value.route as Record<string, unknown>
      : {};
    return buildFallbackIntentDecision({
      target: asString(route.target, asString(value.target, this.options.defaultExecutorName)),
      action: ROUTE_ACTIONS.has(route.action as ExecutorRouteAction)
        ? route.action as ExecutorRouteAction
        : decision.executorDecision?.action ?? 'auto_dispatch',
      primaryIntent: this.normalizePrimaryIntent(route.primaryIntent),
      capabilityClass: this.normalizePrimaryIntent(route.capabilityClass),
      requiredCapabilities: asStringArray(route.requiredCapabilities),
      matchedBoundary: asStringArray(route.matchedBoundary),
      confidence: clampConfidence(value.confidence || decision.confidence),
      reason: asString(value.reason, decision.reason),
      riskLevel: decision.risk === 'high' ? 'high' : decision.risk === 'medium' ? 'medium' : 'low',
      needsLongRunningTask: value.needsLongRunningTask === true,
      requiresLocalRepo: value.requiresLocalRepo === true,
      requiresResearch: value.requiresResearch === true,
      requiresMultiTool: value.requiresMultiTool === true,
      requiresLongTermMemory: value.requiresLongTermMemory === true,
      requiresExternalGateway: value.requiresExternalGateway === true,
      canModifyFiles: value.canModifyFiles === true,
      shouldCreateDurableTask: value.shouldCreateDurableTask === true,
    });
  }

  private normalizePrimaryIntent(value: unknown): TaskRouteIntent {
    if (
      value === 'repo_execution'
      || value === 'technical_reasoning'
      || value === 'research_workflow'
      || value === 'memory_agent_ops'
      || value === 'conversation_or_control'
      || value === 'general'
    ) {
      return value;
    }
    return 'general';
  }

  private normalizeCandidates(raw: unknown, primaryIntent: TaskRouteIntent): ExecutorRouteCandidate[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(item => item && typeof item === 'object')
      .map(item => {
        const value = item as Record<string, unknown>;
        return {
          executorName: asString(value.executorName, this.options.defaultExecutorName),
          score: clampConfidence(value.score),
          reason: asString(value.reason, ''),
          primaryIntent,
          matchedBoundary: asStringArray(value.matchedBoundary),
        };
      });
  }

  private normalizeRejected(raw: unknown): ExecutorRouteRejectedCandidate[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(item => item && typeof item === 'object')
      .map(item => {
        const value = item as Record<string, unknown>;
        return {
          executorName: asString(value.executorName, ''),
          reason: asString(value.reason, ''),
          score: clampConfidence(value.score),
        };
      })
      .filter(item => item.executorName);
  }

  private validateDecision(decision: SemanticIntentDecision): SemanticIntentDecision {
    if (decision.ambiguity.length > 0 && decision.shouldAskBeforeActing) {
      return this.toClarification(decision, '语义裁决存在歧义，需要先确认');
    }

    if (decision.risk === 'high') {
      return this.toClarification(decision, '动作风险高，需要先确认');
    }

    if (decision.confidence < LOW_CONFIDENCE) {
      return this.toClarification(decision, '语义置信度低，需要追问');
    }

    if (decision.confidence < HIGH_CONFIDENCE && this.requiresConfirmationAtMediumConfidence(decision)) {
      return this.toClarification(decision, '中等置信度且动作会改变任务或外部执行状态，需要确认');
    }

    if (
      (decision.interactionType === 'durable_task' || decision.interactionType === 'executor_dispatch')
      && !decision.executorDecision
    ) {
      return this.toClarification(decision, '缺少 executor 语义裁决，需要确认执行方式');
    }

    return decision;
  }

  private requiresConfirmationAtMediumConfidence(decision: SemanticIntentDecision): boolean {
    if (decision.interactionType === 'direct_reply') {
      return false;
    }

    if (decision.risk !== 'low') {
      return true;
    }

    return decision.taskBinding.type === 'reference'
      || decision.interactionType === 'task_control'
      || decision.interactionType === 'executor_dispatch';
  }

  private toClarification(decision: SemanticIntentDecision, reason: string): SemanticIntentDecision {
    return {
      ...decision,
      interactionType: 'clarification',
      shouldAskBeforeActing: true,
      reason: decision.reason ? `${reason}：${decision.reason}` : reason,
      clarificationQuestion: decision.clarificationQuestion
        ?? '你希望我直接执行、继续某个已有任务，还是先作为普通对话回答？',
    };
  }

  private buildPrompt(userInput: string, recentTasks: TaskSummary[]): string {
    return [
      '你是 MetaClaw 的顶层语义意图路由器。你必须根据语义判断用户真实意图，不要用关键词命中做主判断。',
      '只返回 JSON 对象，不要解释，不要 markdown。',
      '',
      '决策目标：',
      '- direct_reply：普通对话、解释、闲聊、无需创建/恢复任务。',
      '- task_control：查询/清理/恢复/解除阻塞/继续已有任务等 MetaClaw 任务控制。',
      '- durable_task：需要创建或绑定长期任务，再进入任务执行准备。',
      '- executor_dispatch：语义上已经能明确选择 executor 或竞速 executor 的可执行任务。',
      '- clarification：低置信度、歧义、风险高、或继续旧任务/改文件/发消息等需要确认。',
      '',
      '置信度策略：confidence >= 0.78 可自动执行；0.55 <= confidence < 0.78 时低风险可默认，高风险或会改文件/发消息/恢复旧任务必须问；confidence < 0.55 必须问。',
      '如果 ambiguity 非空且 shouldAskBeforeActing 为 true，必须 interactionType=clarification。',
      'Codex CLI 是顶层语义裁决来源。失败时上层会保守降级为普通对话，不能用关键词规则直接创建任务。',
      '',
      'executorDecision.action 只能是 auto_dispatch / ask_review / fallback_default / race_executors。',
      '如果 action=race_executors，表示应启动竞速。只有在多个 executor profile 都语义匹配且风险不是 high 时使用。',
      'rejected candidates 的 reason 必须来自语义裁决或 profile 不匹配，不得说 token/关键词命中。',
      '如果 executor profile riskLevel=high，改成 clarification 或 fallback_default，不要 auto_dispatch/race_executors。',
      '',
      `用户输入：${userInput}`,
      '',
      '最近任务：',
      JSON.stringify(recentTasks, null, 2),
      '',
      'Executor profiles：',
      JSON.stringify(this.executorProfiles, null, 2),
      '',
      '返回 JSON schema：',
      JSON.stringify({
        interactionType: 'direct_reply|task_control|durable_task|executor_dispatch|clarification',
        confidence: 0.0,
        shouldAskBeforeActing: false,
        ambiguity: ['歧义点，可为空'],
        risk: 'low|medium|high',
        reason: '简短语义原因',
        clarificationQuestion: '需要追问时的问题，否则 null',
        taskBinding: {
          type: 'new|reference|none',
          taskId: 'task id or null',
          reason: '绑定原因',
        },
        taskControl: {
          kind: 'clear_tasks|status_query|resume_task|recover_blocked|last_task_continuation|unknown',
          taskId: 'task id or null',
          scope: 'all|parked|blocked|running|dashboard|null',
          reason: '任务控制原因',
        },
        executorDecision: {
          selectedExecutor: 'executor name',
          action: 'auto_dispatch|ask_review|fallback_default|race_executors',
          confidence: 0.0,
          primaryIntent: 'repo_execution|technical_reasoning|research_workflow|memory_agent_ops|conversation_or_control|general',
          matchedBoundary: ['语义边界'],
          reason: '选择原因',
          candidates: [{ executorName: 'name', score: 0.0, reason: '语义匹配原因', matchedBoundary: ['语义边界'] }],
          rejected: [{ executorName: 'name', score: 0.0, reason: '语义或 profile 不匹配原因' }],
        },
      }, null, 2),
    ].join('\n');
  }

  private async awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error('semantic intent router timed out')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
