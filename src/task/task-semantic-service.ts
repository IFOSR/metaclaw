import type { IntentResult, LlmBridge, RouteResult, TaskPriorityResult, TaskResumeIntentResult, TaskSummary } from '../core/llm-bridge.js';

export interface TaskSemanticServiceDeps {
  llmBridge: Partial<Pick<LlmBridge, 'resolveTaskPriority' | 'resolveTaskResumeIntent' | 'resolveRoute' | 'resolveIntent'>>;
  timeoutMs: () => number;
}

export interface LegacyResumeResolutionResult {
  route: RouteResult | null;
  intent: IntentResult | null;
}

export class TaskSemanticService {
  constructor(private readonly deps: TaskSemanticServiceDeps) {}

  hasTaskResumeResolver(): boolean {
    return typeof this.deps.llmBridge.resolveTaskResumeIntent === 'function';
  }

  hasLegacyResumeResolver(): boolean {
    return typeof this.deps.llmBridge.resolveIntent === 'function' || typeof this.deps.llmBridge.resolveRoute === 'function';
  }

  async classifyPriority(userInput: string, fallback: TaskPriorityResult): Promise<TaskPriorityResult> {
    if (typeof this.deps.llmBridge.resolveTaskPriority !== 'function') {
      return fallback;
    }

    return this.awaitWithTimeout(
      this.deps.llmBridge.resolveTaskPriority(userInput),
      this.deps.timeoutMs(),
      fallback,
    );
  }

  async decideResumeTarget(
    userInput: string,
    candidateTasks: TaskSummary[],
    fallback: TaskResumeIntentResult,
  ): Promise<TaskResumeIntentResult> {
    if (typeof this.deps.llmBridge.resolveTaskResumeIntent !== 'function') {
      return fallback;
    }

    return this.awaitWithTimeout(
      this.deps.llmBridge.resolveTaskResumeIntent(userInput, candidateTasks),
      this.deps.timeoutMs(),
      fallback,
    );
  }

  async observeResumeIntent(
    userInput: string,
    candidateTasks: TaskSummary[],
  ): Promise<TaskResumeIntentResult | null> {
    if (typeof this.deps.llmBridge.resolveTaskResumeIntent !== 'function') {
      return null;
    }

    return this.awaitWithTimeout(
      this.deps.llmBridge.resolveTaskResumeIntent(userInput, candidateTasks),
      this.deps.timeoutMs(),
      null,
    );
  }

  async resolveLegacyResumeIntent(
    userInput: string,
    candidateTasks: TaskSummary[],
  ): Promise<LegacyResumeResolutionResult> {
    const route = typeof this.deps.llmBridge.resolveRoute === 'function'
      ? await this.awaitWithTimeout(
          this.deps.llmBridge.resolveRoute(userInput, candidateTasks),
          this.deps.timeoutMs(),
          null,
        )
      : null;
    const intent = typeof this.deps.llmBridge.resolveIntent === 'function'
      ? await this.awaitWithTimeout(
          this.deps.llmBridge.resolveIntent(userInput, candidateTasks),
          this.deps.timeoutMs(),
          null,
        )
      : null;

    return { route, intent };
  }

  private async awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | null = null;

    try {
      return await Promise.race([
        promise,
        new Promise<T>(resolve => {
          timer = setTimeout(() => resolve(fallback), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
