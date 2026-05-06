import type { Task, Preference, ExecutorResult, ExecutionContextBundle } from '../core/types.js';
import type { ParsedSkillUsageEvent } from './skill-usage-event-parser.js';

export interface ExecutorSkillGovernanceTarget {
  skillName: string;
  skillVersion: string | null;
}

export interface ConversationTurn {
  taskId: string;
  userInput: string;
  systemOutput: string;
  createdAt: string;
  source: 'task' | 'session' | 'timeline' | 'keyword' | 'llm';
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
  kind: 'status' | 'log' | 'skill';
  text: string;
  skillEvent?: ParsedSkillUsageEvent;
}

export interface ExecutorAdapter {
  readonly name: string;
  execute(input: ExecutorInput): Promise<ExecutorResult>;
  installSkill?(pkg: import('./skill-package-builder.js').ExecutorSkillPackage): Promise<ExecutorSkillInstallResult>;
  updateSkill?(pkg: import('./skill-package-builder.js').ExecutorSkillPackage): Promise<ExecutorSkillInstallResult>;
  disableSkill?(target: ExecutorSkillGovernanceTarget): Promise<ExecutorSkillInstallResult>;
  deprecateSkill?(target: ExecutorSkillGovernanceTarget): Promise<ExecutorSkillInstallResult>;
  isAvailable(): Promise<boolean>;
  abort(): void;
}

export interface ExecutorSkillInstallResult {
  ok: boolean;
  executorName: string;
  installedSkillName?: string;
  installedVersion?: string;
  message: string;
  errorCode?: string;
}
