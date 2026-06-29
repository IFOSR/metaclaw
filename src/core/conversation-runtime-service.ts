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
  appendOutput?: (...lines: string[]) => void;
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
    this.deps.appendOutput?.(
      '【MetaClaw｜召回会话上下文】',
      '→ MetaClaw：正在召回与本次问答相关的最近对话',
    );
    const conversationHistory = await this.deps.memoryContextService.recallConversationContext({
      sessionId: input.sessionId,
      userInput: input.userInput,
    });
    this.deps.appendOutput?.(...this.formatConversationContextProgress(conversationHistory.length));

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

  private formatConversationContextProgress(recalledCount: number): string[] {
    const contextLine = recalledCount > 0
      ? `→ MetaClaw：已召回 ${recalledCount} 条相关会话上下文`
      : '→ MetaClaw：没有召回到相关会话上下文，将按全新问题回答';
    const executorContextLine = recalledCount > 0
      ? `→ Executor: ${this.deps.executor.name} 正在基于当前问题和会话上下文生成回答`
      : `→ Executor: ${this.deps.executor.name} 正在基于当前问题生成回答`;

    return [
      contextLine,
      ...(recalledCount > 0
        ? ['→ MetaClaw：会把召回上下文注入给 Executor，保持连续问答衔接']
        : []),
      `【Executor: ${this.deps.executor.name}｜回答生成】`,
      executorContextLine,
    ];
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
