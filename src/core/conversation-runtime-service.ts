import type { ConversationTurn, ExecutorAdapter } from '../executor/adapter.js';
import { generateInteractionId } from '../utils/id.js';
import type { SessionPersistenceService } from './session-persistence-service.js';
import type { TaskFocusContext } from './task-runtime-service.js';
import type { Task } from './types.js';

export interface ConversationMemoryContextService {
  recallConversationContext(input: { sessionId: string; userInput: string; taskId?: string }): Promise<ConversationTurn[]>;
}

export interface ConversationRuntimeServiceDeps {
  executor: ExecutorAdapter;
  memoryContextService: ConversationMemoryContextService;
  persistenceService: Pick<SessionPersistenceService, 'recordInteraction'>;
}

export interface ConversationRuntimeInput {
  sessionId: string;
  userInput: string;
}

export interface ConversationRuntimeResult {
  success: boolean;
  lines: string[];
  focus: TaskFocusContext | null;
}

export class ConversationRuntimeService {
  constructor(private readonly deps: ConversationRuntimeServiceDeps) {}

  async run(input: ConversationRuntimeInput): Promise<ConversationRuntimeResult> {
    const conversationHistory = await this.deps.memoryContextService.recallConversationContext({
      sessionId: input.sessionId,
      userInput: input.userInput,
    });

    try {
      const result = await this.deps.executor.execute({
        task: this.buildConversationTask(input.userInput),
        preferences: [],
        userPrompt: input.userInput,
        conversationHistory,
      });

      if (!result.success) {
        return {
          success: false,
          lines: [`✗ 对话失败: ${result.error || '未知错误'}`],
          focus: null,
        };
      }

      this.deps.persistenceService.recordInteraction({
        taskId: null,
        sessionId: input.sessionId,
        userInput: input.userInput,
        systemOutput: result.output,
        executorUsed: this.deps.executor.name,
      });

      return {
        success: true,
        lines: [result.output],
        focus: { kind: 'conversation', taskId: null },
      };
    } catch (error) {
      return {
        success: false,
        lines: [`✗ 对话异常: ${(error as Error).message}`],
        focus: null,
      };
    }
  }

  private buildConversationTask(userInput: string): Task {
    const now = new Date().toISOString();
    return {
      id: `conv_${generateInteractionId()}`,
      title: '普通对话',
      goal: userInput,
      status: 'running',
      summary: '',
      snapshots: [],
      resources: [],
      artifacts: [],
      dependencies: [],
      prioritySignals: {
        dueAt: null,
        isReady: true,
        progressRatio: 0,
        blocksOthers: false,
        idleHours: 0,
      },
      injectedPreferences: [],
      lastSchedulingReason: '',
      lastInterruptionReason: '',
      interruptionCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }
}
