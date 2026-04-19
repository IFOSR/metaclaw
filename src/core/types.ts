// ─── 任务状态 ───
export const TaskStatus = {
  CREATED: 'created',
  READY: 'ready',
  RUNNING: 'running',
  PARKED: 'parked',
  BLOCKED: 'blocked',
  DONE: 'done',
  ARCHIVED: 'archived',
  CANCELLED: 'cancelled',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

// ─── 任务快照 ───
export interface TaskSnapshot {
  done: string[];           // 已完成内容
  pending: string[];        // 未完成内容
  nextStep: string;         // 下一步建议
  pauseReason: string;      // 暂停原因
  createdAt: string;        // 快照时间
}

// ─── 优先级信号 ───
export interface PrioritySignals {
  dueAt: string | null;     // 截止时间
  isReady: boolean;         // 输入是否齐全
  progressRatio: number;    // 完成比例 0-1
  blocksOthers: boolean;    // 是否阻塞其他任务
  idleHours: number;        // 搁置时长
}

// ─── 任务对象 ───
export interface Task {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  summary: string;
  snapshots: TaskSnapshot[];
  resources: string[];
  artifacts: string[];
  dependencies: Dependency[];
  prioritySignals: PrioritySignals;
  injectedPreferences: string[];
  lastSchedulingReason: string;
  lastInterruptionReason: string;
  interruptionCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── 阻塞依赖 ───
export interface Dependency {
  taskId: string;
  type: 'manual';           // V1 仅支持手动解除
  description: string;
  status: 'waiting' | 'resolved';
  createdAt: string;
}

// ─── 偏好作用域 ───
export const PreferenceScope = {
  GLOBAL: 'global',
  PROJECT: 'project',
  CONTACT: 'contact',
  TASK_LOCAL: 'task-local',
} as const;

export type PreferenceScope = (typeof PreferenceScope)[keyof typeof PreferenceScope];

// ─── 偏好状态 ───
export const PreferenceStatus = {
  OBSERVED: 'observed',
  CANDIDATE: 'candidate',
  CONFIRMED: 'confirmed',
  DORMANT: 'dormant',
  ARCHIVED: 'archived',
  DISCARDED: 'discarded',
} as const;

export type PreferenceStatus = (typeof PreferenceStatus)[keyof typeof PreferenceStatus];

// ─── 偏好对象 ───
export interface Preference {
  id: string;
  type: string;             // contact / style / domain / workflow
  scope: PreferenceScope;
  subject: string | null;
  content: string;
  status: PreferenceStatus;
  confidence: number;
  occurrenceCount: number;
  sourceTasks: string[];
  lastUsedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── 观察记录 ───
export interface Observation {
  id: string;
  pattern: string;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sourceTasks: string[];
  promotedToPreferenceId: string | null;
}

// ─── 主动建议 ───
export interface Suggestion {
  taskId: string;
  type: 'resume_suggestion' | 'priority_suggestion' | 'unblock_reminder';
  reasons: string[];
  recommendedAction: string;
  generatedAt: string;
}

// ─── 执行器结果 ───
export interface ExecutorResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
  durationMs: number;
  interrupted?: boolean;
}

// ─── 恢复摘要 ───
export interface ResumeSummary {
  taskTitle: string;
  lastProgress: string;       // "上次做到哪"
  pauseReason: string;        // "为什么停下"
  currentStatus: string;      // "当前状态"
  nextStep: string;           // "建议先做什么"
  resources: string[];        // "相关材料"
  idleHours: number;          // 搁置了多久
}

// ─── 优先级评分 ───
export interface PriorityScore {
  urgency: number;          // 紧迫度：有截止时间且临近 → 高分
  readiness: number;        // 可执行度：输入齐全 → 高分
  continuityBenefit: number; // 连续性收益：已完成比例高 → 高分
  downstreamImpact: number; // 下游影响：阻塞其他任务 → 高分
  staleness: number;        // 搁置成本：长期未推进 → 高分
  total: number;            // 加权总分
}

// ─── 任务盘面 ───
export interface Dashboard {
  summary: { active: number; blocked: number; parked: number; done: number };
  priorityTask: (Task & { reasons: string[] }) | null;
  blockedTasks: Array<Task & { blockReason: string }>;
  readyTasks: Task[];
}

// ─── 调度运行态 ───
export interface RuntimeState {
  runningTaskId: string | null;
  readyTaskIds: string[];
  blockedTaskIds: string[];
  parkedTaskIds: string[];
  lastEvent: string | null;
}

// ─── 执行上下文包 ───
export interface TaskBrief {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  summary: string;
}

export interface ResumeContext {
  taskTitle: string;
  lastProgress: string;
  completedItems: string[];
  pendingItems: string[];
  pauseReason: string;
  interruptionReason?: string;
  blockedReason?: string;
  nextStep: string;
  schedulingReason?: string;
}

export interface ResolvedPreference {
  id: string;
  content: string;
  scope: PreferenceScope;
  confidence: number;
  reason: string;
}

export interface MemoryContext {
  explicitUserInstruction: string;
  resolvedPreferences: ResolvedPreference[];
}

export interface HistoryContext {
  taskTurns: Array<{
    taskId: string;
    userInput: string;
    systemOutput: string;
    createdAt: string;
    source: 'task' | 'session' | 'keyword' | 'llm';
  }>;
  sessionTurns: Array<{
    taskId: string;
    userInput: string;
    systemOutput: string;
    createdAt: string;
    source: 'task' | 'session' | 'keyword' | 'llm';
  }>;
  relatedTurns: Array<{
    taskId: string;
    userInput: string;
    systemOutput: string;
    createdAt: string;
    source: 'task' | 'session' | 'keyword' | 'llm';
  }>;
}

export interface MaterialContext {
  resources: string[];
  textSnippets?: Array<{
    path: string;
    content: string;
    sourceType: 'file' | 'link';
  }>;
  summary?: {
    totalCount: number;
    localFileCount: number;
    webLinkCount: number;
    fileSnippetCount: number;
    linkSnippetCount: number;
    readableSnippetCount: number;
    status: 'missing' | 'partial' | 'ready';
    overview: string;
    sufficiency: string;
  };
}

export interface WorkspaceContext {
  allowFilesystem: boolean;
  workingDirectory: string;
  targetPaths: string[];
}

export interface ExecutionContextBundle {
  mode: 'fresh' | 'resume-parked' | 'resume-blocked' | 'follow-up';
  taskBrief: TaskBrief;
  resumeContext?: ResumeContext;
  memoryContext: MemoryContext;
  historyContext: HistoryContext;
  materialContext: MaterialContext;
  workspaceContext?: WorkspaceContext;
  executionInstructions: string[];
}

// ─── 配置 ───
export interface Config {
  version: number;
  executor: {
    command: string;
    timeout: number;
  };
  orchestration: {
    reminder_enabled: boolean;
    reminder_throttle: number;
    top_k_preferences: number;
  };
  ui: {
    language: string;
    dashboard_on_start: boolean;
  };
}
