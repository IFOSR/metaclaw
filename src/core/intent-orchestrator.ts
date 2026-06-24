import type { ExecutorProfile, TaskRouteIntent } from './executor-router.js';
import type { LlmBridge, TaskSummary } from './llm-bridge.js';
import { SemanticIntentRouter, type SemanticIntentDecision } from './semantic-intent-router.js';
import type { RuleHint } from './rule-hints-provider.js';

export type IntentInteractionType =
  | 'direct_reply'
  | 'task_control'
  | 'durable_task'
  | 'executor_dispatch'
  | 'clarification';

export type IntentRiskLevel = 'low' | 'medium' | 'high';
export type IntentTaskBinding = 'new' | 'reference' | 'none';
export type IntentTaskControl =
  | 'clear_tasks'
  | 'status_query'
  | 'resume_task'
  | 'recover_blocked'
  | 'last_task_continuation'
  | 'none';
export type IntentExecutionMode = 'none' | 'single_executor' | 'race_executors' | 'multi_executor';
export type IntentExecutionComplexity = 'simple' | 'moderate' | 'complex';

export interface IntentOrchestratorInput {
  userInput: string;
  recentTasks: TaskSummary[];
  executorProfiles: ExecutorProfile[];
  defaultExecutorName: string;
  currentFocus: {
    kind: 'conversation' | 'task';
    taskId: string | null;
  } | null;
  hints: RuleHint[];
  allowDurableTask: boolean;
  allowFileModification: boolean;
  timeoutMs: number;
}

export interface IntentDecisionV2 {
  interactionType: IntentInteractionType;
  confidence: number;
  reason: string;
  clarificationQuestion: string | null;
  risk: {
    level: IntentRiskLevel;
    requiresConfirmation: boolean;
    reasons: string[];
  };
  task: {
    binding: IntentTaskBinding;
    taskId: string | null;
    control: IntentTaskControl;
    scope: string | null;
  };
  execution: {
    mode: IntentExecutionMode;
    complexity: IntentExecutionComplexity;
    selectedExecutor: string | null;
    candidateExecutors: string[];
    requiresVerification: boolean;
    canModifyFiles: boolean;
    requiresExternalGateway: boolean;
    primaryIntent?: TaskRouteIntent;
    matchedBoundary?: string[];
  };
  hints: RuleHint[];
}

interface SemanticRouterLike {
  decide(userInput: string, recentTasks: TaskSummary[], hints?: RuleHint[]): Promise<SemanticIntentDecision>;
}

interface IntentOrchestratorDeps {
  semanticRouter: SemanticRouterLike | SemanticIntentRouter;
}

export interface DefaultIntentOrchestratorOptions {
  llmBridge: LlmBridge;
  executorProfiles: ExecutorProfile[];
  defaultExecutorName: string;
  llmTimeoutMs?: number;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('intent orchestrator timeout')), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

export class IntentOrchestrator {
  constructor(private deps: IntentOrchestratorDeps) {}

  static createDefault(options: DefaultIntentOrchestratorOptions): IntentOrchestrator {
    return new IntentOrchestrator({
      semanticRouter: new SemanticIntentRouter(
        options.llmBridge,
        options.executorProfiles,
        {
          defaultExecutorName: options.defaultExecutorName,
          llmTimeoutMs: options.llmTimeoutMs,
        },
      ),
    });
  }

  async decide(input: IntentOrchestratorInput): Promise<IntentDecisionV2> {
    try {
      const semantic = await withTimeout(
        this.deps.semanticRouter.decide(input.userInput, input.recentTasks, input.hints),
        input.timeoutMs,
      );
      return this.normalizeSemanticDecision(semantic, input);
    } catch (error) {
      return this.conservativeDecision(input, (error as Error).message);
    }
  }

  private normalizeSemanticDecision(
    semantic: SemanticIntentDecision,
    input: IntentOrchestratorInput,
  ): IntentDecisionV2 {
    const riskLevel = semantic.risk;
    const highRisk = riskLevel === 'high' || input.hints.some(hint => hint.source === 'safety_guard' && hint.weight >= 0.9);
    const interactionType = highRisk
      ? 'clarification'
      : semantic.interactionType;
    const executorDecision = semantic.executorDecision;
    const candidateExecutors = executorDecision
      ? executorDecision.candidates.map(candidate => candidate.executorName)
      : [];
    const selectedExecutor = executorDecision?.selectedExecutor ?? null;
    const executionMode = this.resolveExecutionMode(interactionType, executorDecision?.action ?? null);
    const taskBinding = interactionType === 'task_control'
      ? semantic.taskControl?.taskId ? 'reference' : 'none'
      : semantic.taskBinding.type;
    const taskId = interactionType === 'task_control'
      ? semantic.taskControl?.taskId ?? null
      : semantic.taskBinding.taskId;
    const complexity = executionMode === 'multi_executor'
      ? 'complex'
      : executionMode === 'race_executors'
        ? 'moderate'
        : this.inferComplexity(semantic);

    return {
      interactionType,
      confidence: clampConfidence(semantic.confidence),
      reason: highRisk && semantic.interactionType !== 'clarification'
          ? `高风险动作需要确认：${semantic.reason}`
          : semantic.reason,
      clarificationQuestion: highRisk
        ? semantic.clarificationQuestion ?? '请确认是否继续执行这个高风险动作。'
        : semantic.clarificationQuestion,
      risk: {
        level: riskLevel,
        requiresConfirmation: highRisk || semantic.shouldAskBeforeActing,
        reasons: [
          semantic.reason,
          ...input.hints
            .filter(hint => hint.source === 'safety_guard')
            .map(hint => hint.reason),
        ].filter(Boolean),
      },
      task: {
        binding: taskBinding,
        taskId,
        control: semantic.taskControl ? this.normalizeControl(semantic.taskControl.kind) : 'none',
        scope: semantic.taskControl?.scope ?? null,
      },
      execution: {
        mode: executionMode,
        complexity,
        selectedExecutor,
        candidateExecutors: candidateExecutors.length > 0
          ? candidateExecutors
          : selectedExecutor ? [selectedExecutor] : [],
        requiresVerification: executionMode !== 'none' && interactionType !== 'clarification',
        canModifyFiles: executorDecision?.primaryIntent === 'repo_execution' && input.allowFileModification,
        requiresExternalGateway: executorDecision?.matchedBoundary.includes('messaging_gateway') ?? false,
        primaryIntent: executorDecision?.primaryIntent,
        matchedBoundary: executorDecision?.matchedBoundary ?? [],
      },
      hints: input.hints,
    };
  }

  private conservativeDecision(input: IntentOrchestratorInput, reason: string): IntentDecisionV2 {
    return {
      interactionType: 'clarification',
      confidence: 0,
      reason: `IntentOrchestrator conservative fallback: ${reason}`,
      clarificationQuestion: '我不确定你是要聊天、创建新任务、恢复旧任务还是派发执行器。请明确说明下一步动作。',
      risk: {
        level: input.hints.some(hint => hint.source === 'safety_guard') ? 'high' : 'low',
        requiresConfirmation: input.hints.some(hint => hint.source === 'safety_guard'),
        reasons: input.hints.map(hint => hint.reason),
      },
      task: {
        binding: 'none',
        taskId: null,
        control: 'none',
        scope: null,
      },
      execution: {
        mode: 'none',
        complexity: 'simple',
        selectedExecutor: null,
        candidateExecutors: [],
        requiresVerification: false,
        canModifyFiles: false,
        requiresExternalGateway: false,
        matchedBoundary: [],
      },
      hints: input.hints,
    };
  }

  private resolveExecutionMode(
    interactionType: IntentInteractionType,
    action: string | null,
  ): IntentExecutionMode {
    if (interactionType === 'clarification' || interactionType === 'direct_reply' || interactionType === 'task_control') {
      return 'none';
    }
    if (action === 'race_executors') {
      return 'race_executors';
    }
    if (interactionType === 'durable_task' || interactionType === 'executor_dispatch') {
      return 'single_executor';
    }
    return 'none';
  }

  private normalizeControl(kind: SemanticIntentDecision['taskControl'] extends infer T
    ? T extends { kind: infer K } ? K : never
    : never): IntentTaskControl {
    if (
      kind === 'clear_tasks'
      || kind === 'status_query'
      || kind === 'resume_task'
      || kind === 'recover_blocked'
      || kind === 'last_task_continuation'
    ) {
      return kind;
    }
    return 'none';
  }

  private inferComplexity(semantic: SemanticIntentDecision): IntentExecutionComplexity {
    if (semantic.executorDecision?.matchedBoundary.some(boundary => boundary === 'research' || boundary === 'multi_tool')) {
      return 'moderate';
    }
    return 'simple';
  }
}

export type { RuleHint } from './rule-hints-provider.js';
