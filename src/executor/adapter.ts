import type { Task, Preference, ExecutorResult, ExecutionContextBundle } from '../core/types.js';

export interface ConversationTurn {
  taskId: string;
  userInput: string;
  systemOutput: string;
  createdAt: string;
  source: 'task' | 'session' | 'keyword' | 'llm';
}

export interface ExecutorInput {
  task: Task;
  preferences: Preference[];
  userPrompt: string;
  conversationHistory: ConversationTurn[];
  executionContextBundle?: ExecutionContextBundle;
  onProgress?: (event: ExecutorProgressEvent) => void;
}

export interface ExecutorProgressEvent {
  kind: 'status' | 'log';
  text: string;
}

export interface ExecutorAdapter {
  readonly name: string;
  execute(input: ExecutorInput): Promise<ExecutorResult>;
  isAvailable(): Promise<boolean>;
  abort(): void;
}
