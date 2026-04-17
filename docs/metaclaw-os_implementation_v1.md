# Metaclaw V1 技术实施方案

> 本文档已补充多任务调度、恢复上下文和任务清单要求。详细设计见：`docs/plans/2026-04-16-multitask-scheduler-and-resume-design.md`

## 1. 技术栈选型

| 层面 | 选型 | 理由 |
|------|------|------|
| 语言 | TypeScript 5.x | 类型安全，Claude Code 同生态 |
| 运行时 | Node.js 20 LTS | 长期支持，原生 ESM |
| TUI 框架 | ink 5 + React 18 | 声明式组件渲染，社区活跃 |
| 数据库 | better-sqlite3 | 同步 API，零配置，适合本地单机 |
| CLI 解析 | commander | 斜杠命令解析 + 子命令路由 |
| 构建 | tsup | 零配置 TS 打包，输出 ESM |
| 测试 | vitest | 快速，原生 TS 支持 |
| 日志 | pino | 结构化日志，低开销 |
| 配置 | yaml (js-yaml) | 与 `~/.metaclaw/config.yaml` 配置结构一致 |

### 核心依赖清单

```json
{
  "dependencies": {
    "ink": "^5.0.0",
    "react": "^18.3.0",
    "better-sqlite3": "^11.0.0",
    "commander": "^12.0.0",
    "js-yaml": "^4.1.0",
    "pino": "^9.0.0",
    "nanoid": "^5.0.0",
    "dayjs": "^1.11.0",
    "chalk": "^5.3.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsup": "^8.0.0",
    "vitest": "^2.0.0",
    "@types/react": "^18.3.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/js-yaml": "^4.0.0",
    "ink-testing-library": "^4.0.0"
  }
}
```

---

## 2. 项目结构

```
metaclaw-os/
├── docs/                          # 设计文档（已有）
├── src/
│   ├── index.ts                   # 入口：CLI 解析 + TUI 启动
│   ├── core/
│   │   ├── task-engine.ts         # 任务引擎：CRUD、状态机、快照
│   │   ├── memory-engine.ts       # 偏好引擎：观察、提取、召回
│   │   ├── orchestration.ts       # 编排引擎：盘面、优先级、建议
│   │   ├── scheduler.ts           # 调度引擎：排队、抢占、恢复
│   │   ├── resume-context-builder.ts # 恢复上下文构建
│   │   └── types.ts               # 核心类型定义
│   ├── executor/
│   │   ├── adapter.ts             # 执行器抽象接口
│   │   ├── codex-cli.ts           # codex cli 适配器
│   │   ├── claude-code.ts         # claude code 兼容适配器
│   │   └── factory.ts             # 执行器工厂
│   ├── storage/
│   │   ├── database.ts            # SQLite 连接与初始化
│   │   ├── migrations.ts          # Schema 迁移
│   │   ├── task-repo.ts           # 任务数据访问
│   │   ├── preference-repo.ts     # 偏好数据访问
│   │   └── observation-repo.ts    # 观察记录数据访问
│   ├── tui/
│   │   ├── app.tsx                # TUI 根组件
│   │   ├── components/
│   │   │   ├── dashboard.tsx      # 任务盘面
│   │   │   ├── task-detail.tsx    # 任务详情
│   │   │   ├── prompt.tsx         # 输入区
│   │   │   ├── status-bar.tsx     # 状态栏
│   │   │   └── preference-list.tsx # 偏好列表
│   │   └── hooks/
│   │       ├── use-task.ts        # 任务操作 hook
│   │       ├── use-memory.ts      # 偏好操作 hook
│   │       └── use-orchestration.ts # 编排 hook
│   ├── commands/
│   │   ├── router.ts              # 斜杠命令路由
│   │   ├── task-commands.ts       # /task, /tasks 命令
│   │   ├── memory-commands.ts     # /memory 命令
│   │   └── global-commands.ts     # /dashboard, /attach, /help
│   └── utils/
│       ├── config.ts              # 配置加载（~/.metaclaw/config.yaml）
│       ├── logger.ts              # 日志封装
│       └── id.ts                  # ID 生成
├── tests/
│   ├── core/
│   │   ├── task-engine.test.ts
│   │   ├── memory-engine.test.ts
│   │   └── orchestration.test.ts
│   ├── executor/
│   │   └── claude-code.test.ts
│   ├── storage/
│   │   └── repos.test.ts
│   └── commands/
│       └── router.test.ts
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
└── CLAUDE.md
```

---

## 3. 核心模块详细设计

### 3.0 实施原则补充
- 输入框始终可用，不能再被全局执行态锁死
- 单执行器只限制同一时刻的执行实例，不限制多任务存在
- 任务恢复必须通过统一的 `ExecutionContextBundle` 装配任务快照、历史与记忆
- 所有调度行为都要可测试、可解释、可在 TUI 中可见

### 3.1 类型定义 (`src/core/types.ts`)

```typescript
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
}

// ─── 调度运行态 ───
export interface RuntimeState {
  runningTaskId: string | null;
  readyTaskIds: string[];
  blockedTaskIds: string[];
  parkedTaskIds: string[];
  lastEvent: string | null;
}
```

### 3.1.1 关键新增模块
- `SchedulerEngine`
  - 接收提交
  - 计算是否立即执行、排队或抢占
  - 处理 `running -> parked` 的抢占快照
  - 处理 `blocked` 后自动切换下一个任务
- `ResumeContextBuilder`
  - 为 `fresh / resume-parked / resume-blocked / follow-up` 四类任务构建统一执行上下文
  - 装配任务快照、任务历史、关联历史和偏好记忆

### 3.2 Task Engine (`src/core/task-engine.ts`)

任务引擎是系统核心，负责任务全生命周期管理。

#### 状态机迁移规则

```typescript
// 合法状态迁移表
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  created:   ['ready', 'cancelled'],
  ready:     ['running', 'cancelled'],
  running:   ['parked', 'blocked', 'done'],
  parked:    ['ready', 'cancelled'],
  blocked:   ['ready'],
  done:      ['archived'],
  archived:  [],
  cancelled: [],
};
```

#### 状态语义补充
- `ready`：进入候选队列，等待调度
- `running`：当前唯一正在执行的任务
- `parked`：被用户暂停、被高优任务抢占或被安全中断后待恢复的任务
- `blocked`：依赖未满足，不参与调度，但不会锁住整个会话

#### 核心方法

```typescript
class TaskEngine {
  constructor(private taskRepo: TaskRepo, private snapshotDir: string) {}

  // 创建任务：自然语言输入 → 结构化任务对象
  // 自动设置 status = CREATED，生成 ID，记录时间戳
  create(input: { title: string; goal: string; resources?: string[] }): Task

  // 状态迁移：校验合法性，触发副作用
  transition(taskId: string, targetStatus: TaskStatus, context?: object): Task

  // 挂起任务：RUNNING → PARKED
  // 自动生成快照，记录暂停原因
  park(taskId: string, reason: string, snapshot: Omit<TaskSnapshot, 'createdAt'>): Task

  // 恢复任务：PARKED → READY
  // 返回恢复摘要（上次做到哪、为什么停、下一步建议）
  resume(taskId: string): { task: Task; resumeSummary: ResumeSummary }

  // 标记阻塞：RUNNING → BLOCKED
  block(taskId: string, dependency: Omit<Dependency, 'createdAt'>): Task

  // 解除阻塞：BLOCKED → READY
  unblock(taskId: string): Task

  // 关联资源
  attachResource(taskId: string, resourcePath: string): Task

  // 获取最新快照
  getLatestSnapshot(taskId: string): TaskSnapshot | null
}
```

#### 快照生成策略

快照在以下时机自动生成：
1. `RUNNING → PARKED`：必须生成
2. 用户主动 `/task <id> save`：手动触发
3. 执行器返回部分结果后中断：尽力保存

快照存储为 JSON 文件：`~/.metaclaw/snapshots/{taskId}/snapshot_{timestamp}.json`

#### 恢复摘要结构

```typescript
interface ResumeSummary {
  taskTitle: string;
  lastProgress: string;       // "上次做到哪"
  pauseReason: string;        // "为什么停下"
  currentStatus: string;      // "当前状态"
  nextStep: string;           // "建议先做什么"
  resources: string[];        // "相关材料"
  idleHours: number;          // 搁置了多久
}
```

---

### 3.3 Memory Engine (`src/core/memory-engine.ts`)

偏好记忆引擎实现"三次确认原则"和分层作用域召回。

#### 核心流程

```
用户交互 → 提取模式 → observations 表
                          ↓ (第1次)
                       observed
                          ↓ (第2次)
                       candidate
                          ↓ (第3次)
                    待确认 → 用户确认 → preferences 表 (confirmed)
                              ↓ 用户拒绝
                           discarded
```

#### 核心方法

```typescript
class MemoryEngine {
  constructor(
    private prefRepo: PreferenceRepo,
    private obsRepo: ObservationRepo
  ) {}

  // 观察记录：从交互中提取模式
  // 自动计数，达到阈值时提升状态
  observe(pattern: string, taskId: string): {
    observation: Observation;
    shouldPromptConfirm: boolean;  // 达到3次时为 true
  }

  // 用户确认偏好
  confirm(observationId: string, scope: PreferenceScope, subject?: string): Preference

  // 用户拒绝候选偏好
  reject(observationId: string): void

  // 用户手动添加偏好（跳过三次确认）
  addManual(input: {
    content: string;
    scope: PreferenceScope;
    type: string;
    subject?: string;
  }): Preference

  // 偏好召回：根据当前上下文返回相关偏好
  recall(context: {
    taskId?: string;
    keywords: string[];
    subject?: string;
  }): Preference[]

  // 偏好 CRUD
  update(prefId: string, changes: Partial<Preference>): Preference
  delete(prefId: string): void
  list(filter?: { scope?: PreferenceScope; status?: PreferenceStatus }): Preference[]
  getCandidates(): Observation[]  // 待确认列表
}
```

#### 召回算法（V1）

```typescript
function recall(context: RecallContext): Preference[] {
  const results: ScoredPreference[] = [];

  // 1. 精确匹配 subject
  if (context.subject) {
    const exact = prefRepo.findBySubject(context.subject);
    exact.forEach(p => results.push({ pref: p, score: 10 }));
  }

  // 2. 关键词匹配 content
  for (const keyword of context.keywords) {
    const matched = prefRepo.searchByKeyword(keyword);
    matched.forEach(p => {
      const existing = results.find(r => r.pref.id === p.id);
      if (existing) existing.score += 3;
      else results.push({ pref: p, score: 3 });
    });
  }

  // 3. 只保留 confirmed 状态
  const confirmed = results.filter(r => r.pref.status === 'confirmed');

  // 4. 按作用域优先级排序
  const scopePriority = { 'task-local': 4, contact: 3, project: 2, global: 1 };
  confirmed.sort((a, b) => {
    const scopeDiff = (scopePriority[b.pref.scope] ?? 0) - (scopePriority[a.pref.scope] ?? 0);
    return scopeDiff !== 0 ? scopeDiff : b.score - a.score;
  });

  // 5. Top-K 截取（默认 5）
  return confirmed.slice(0, 5).map(r => r.pref);
}
```

---

### 3.4 Orchestration Engine (`src/core/orchestration.ts`)

编排引擎负责生成任务盘面、优先级排序和主动建议。

#### 优先级评分模型

基于 PRD 定义的五个维度，每个维度 0-10 分，加权求和：

```typescript
interface PriorityScore {
  urgency: number;          // 紧迫度：有截止时间且临近 → 高分
  readiness: number;        // 可执行度：输入齐全 → 高分
  continuityBenefit: number; // 连续性收益：已完成比例高 → 高分
  downstreamImpact: number; // 下游影响：阻塞其他任务 → 高分
  staleness: number;        // 搁置成本：长期未推进 → 高分
  total: number;            // 加权总分
}

const WEIGHTS = {
  urgency: 3,
  readiness: 2,
  continuityBenefit: 2,
  downstreamImpact: 2,
  staleness: 1,
};
```

#### 评分规则

```typescript
function scoreUrgency(task: Task): number {
  if (!task.prioritySignals.dueAt) return 0;
  const hoursLeft = diffHours(now(), task.prioritySignals.dueAt);
  if (hoursLeft < 0) return 10;    // 已过期
  if (hoursLeft < 4) return 9;
  if (hoursLeft < 24) return 7;
  if (hoursLeft < 72) return 4;
  return 1;
}

function scoreReadiness(task: Task): number {
  return task.prioritySignals.isReady ? 8 : 2;
}

function scoreContinuityBenefit(task: Task): number {
  return Math.round(task.prioritySignals.progressRatio * 10);
}

function scoreDownstreamImpact(task: Task): number {
  return task.prioritySignals.blocksOthers ? 8 : 0;
}

function scoreStaleness(task: Task): number {
  const hours = task.prioritySignals.idleHours;
  if (hours > 168) return 8;   // > 1 周
  if (hours > 72) return 5;    // > 3 天
  if (hours > 24) return 3;    // > 1 天
  return 0;
}
```

#### 核心方法

```typescript
class OrchestrationEngine {
  constructor(private taskEngine: TaskEngine) {}

  // 生成任务盘面
  getDashboard(): Dashboard

  // 获取优先级排序后的 READY 任务
  getPrioritizedTasks(): Array<Task & { score: PriorityScore; reasons: string[] }>

  // 获取所有 BLOCKED 任务及卡点原因
  getBlockedTasks(): Array<Task & { blockReason: string }>

  // 任务完成后推荐下一个
  suggestNext(completedTaskId: string): Suggestion | null

  // 生成主动建议（启动时 + 空闲时调用）
  generateSuggestions(): Suggestion[]
}

interface Dashboard {
  summary: { active: number; blocked: number; parked: number; done: number };
  priorityTask: (Task & { reasons: string[] }) | null;
  blockedTasks: Array<Task & { blockReason: string }>;
  readyTasks: Task[];
}
```

#### 建议原因生成

每条建议必须附带可解释的原因，示例：

```typescript
function generateReasons(task: Task, score: PriorityScore): string[] {
  const reasons: string[] = [];
  if (score.continuityBenefit >= 7)
    reasons.push(`已完成 ${Math.round(task.prioritySignals.progressRatio * 100)}%，继续成本最低`);
  if (score.readiness >= 8)
    reasons.push('所有输入材料已齐全');
  if (score.urgency >= 7)
    reasons.push(`截止时间临近`);
  if (score.downstreamImpact >= 8)
    reasons.push('阻塞了其他任务');
  if (score.staleness >= 5)
    reasons.push(`已搁置 ${task.prioritySignals.idleHours} 小时`);
  return reasons;
}
```

---

### 3.5 Executor Adapter (`src/executor/`)

#### 抽象接口

```typescript
// adapter.ts
interface ExecutorAdapter {
  readonly name: string;

  // 执行任务，注入上下文和偏好
  execute(input: ExecutorInput): Promise<ExecutorResult>;

  // 检查执行器是否可用
  isAvailable(): Promise<boolean>;

  // 中断正在执行的任务
  abort(): void;
}

interface ExecutorInput {
  task: Task;
  preferences: Preference[];
  userPrompt: string;
}
```

#### Claude Code 适配器

```typescript
// claude-code.ts
class ClaudeCodeAdapter implements ExecutorAdapter {
  readonly name = 'claude-code';
  private process: ChildProcess | null = null;

  constructor(private config: { command: string; timeout: number }) {}

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const contextPrompt = this.buildContextPrompt(input);
    const startTime = Date.now();

    return new Promise((resolve) => {
      this.process = spawn(this.config.command, [
        '--print',           // 非交互模式，直接输出结果
        contextPrompt,
      ], {
        timeout: this.config.timeout * 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      this.process.stdout?.on('data', (chunk) => { stdout += chunk; });
      this.process.stderr?.on('data', (chunk) => { stderr += chunk; });

      this.process.on('close', (code) => {
        resolve({
          success: code === 0,
          output: stdout.trim(),
          error: stderr.trim() || undefined,
          exitCode: code ?? 1,
          durationMs: Date.now() - startTime,
        });
        this.process = null;
      });
    });
  }

  // 构建注入上下文
  private buildContextPrompt(input: ExecutorInput): string {
    const lines = [
      '[Metaclaw 上下文注入]',
      `任务：${input.task.title}`,
      `目标：${input.task.goal}`,
    ];

    if (input.task.summary) {
      lines.push(`已完成：${input.task.summary}`);
    }

    if (input.preferences.length > 0) {
      lines.push('用户偏好：');
      input.preferences.forEach(p =>
        lines.push(`  - [${p.scope}] ${p.content}`)
      );
    }

    if (input.task.resources.length > 0) {
      lines.push(`关联材料：${input.task.resources.join(', ')}`);
    }

    lines.push('', `用户指令：${input.userPrompt}`);
    return lines.join('\n');
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { status } = spawnSync('which', [this.config.command]);
      return status === 0;
    } catch {
      return false;
    }
  }

  abort(): void {
    this.process?.kill('SIGTERM');
    this.process = null;
  }
}
```

---

### 3.6 Storage Layer (`src/storage/`)

#### 数据库初始化与迁移

```typescript
// database.ts
import Database from 'better-sqlite3';
import { runMigrations } from './migrations';

export function createDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
```

```typescript
// migrations.ts
const MIGRATIONS = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        summary TEXT,
        snapshot_json TEXT DEFAULT '[]',
        resources_json TEXT DEFAULT '[]',
        dependencies_json TEXT DEFAULT '[]',
        priority_json TEXT,
        injected_prefs_json TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS preferences (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        subject TEXT,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'observed',
        confidence REAL DEFAULT 0,
        occurrence_count INTEGER DEFAULT 1,
        source_tasks TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        confirmed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS preference_usage (
        id TEXT PRIMARY KEY,
        preference_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        injected_at TEXT NOT NULL,
        was_overridden INTEGER DEFAULT 0,
        FOREIGN KEY (preference_id) REFERENCES preferences(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        occurrence_count INTEGER DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        source_tasks TEXT DEFAULT '[]',
        promoted_to_preference_id TEXT
      );

      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        user_input TEXT,
        system_output TEXT,
        executor_used TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_tasks_status ON tasks(status);
      CREATE INDEX idx_preferences_scope ON preferences(scope);
      CREATE INDEX idx_preferences_status ON preferences(status);
      CREATE INDEX idx_observations_pattern ON observations(pattern);
    `,
  },
];

export function runMigrations(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);
  const current = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as any;
  const currentVersion = current?.v ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      db.exec(migration.up);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
    }
  }
}
```

#### Repository 模式

每个数据表对应一个 Repo 类，封装 SQL 操作，对外暴露类型安全的接口。

```typescript
// task-repo.ts（核心方法签名）
class TaskRepo {
  constructor(private db: Database.Database) {}

  insert(task: Task): void
  findById(id: string): Task | null
  findByStatus(status: TaskStatus): Task[]
  findActive(): Task[]                    // READY + RUNNING + PARKED + BLOCKED
  update(id: string, changes: Partial<Task>): void
  updateStatus(id: string, status: TaskStatus): void
  appendSnapshot(id: string, snapshot: TaskSnapshot): void
}

// preference-repo.ts
class PreferenceRepo {
  constructor(private db: Database.Database) {}

  insert(pref: Preference): void
  findById(id: string): Preference | null
  findBySubject(subject: string): Preference[]
  searchByKeyword(keyword: string): Preference[]
  findByStatus(status: PreferenceStatus): Preference[]
  findByScope(scope: PreferenceScope): Preference[]
  update(id: string, changes: Partial<Preference>): void
  delete(id: string): void
  recordUsage(prefId: string, taskId: string): void
}

// observation-repo.ts
class ObservationRepo {
  constructor(private db: Database.Database) {}

  findByPattern(pattern: string): Observation | null
  upsert(pattern: string, taskId: string): Observation  // 存在则 count++
  findCandidates(): Observation[]                        // count >= 3 且未提升
  markPromoted(id: string, preferenceId: string): void
}
```

---

## 4. TUI 层设计 (`src/tui/`)

### 4.1 组件架构

```
App (app.tsx)
├── StatusBar          # 顶部状态栏：活跃任务数、Blocked 数
├── MainView           # 主内容区（根据模式切换）
│   ├── DashboardView  # /dashboard 盘面
│   ├── TaskDetailView # 任务详情
│   ├── PreferenceView # 偏好管理
│   └── ConversationView # 默认对话模式
│       ├── MessageList  # 消息历史
│       └── ExecutorOutput # 执行器输出
└── Prompt             # 底部输入区
```

### 4.2 应用状态管理

使用 React Context + useReducer 管理全局状态：

```typescript
interface AppState {
  mode: 'conversation' | 'dashboard' | 'task-detail' | 'preference';
  currentTaskId: string | null;     // 当前正在处理的任务
  messages: Message[];              // 对话历史
  isExecuting: boolean;             // 执行器是否运行中
}

type AppAction =
  | { type: 'SET_MODE'; mode: AppState['mode'] }
  | { type: 'SET_CURRENT_TASK'; taskId: string | null }
  | { type: 'ADD_MESSAGE'; message: Message }
  | { type: 'SET_EXECUTING'; value: boolean };
```

### 4.3 输入处理流程

```
用户输入
  ↓
是否以 / 开头？
  ├─ 是 → 斜杠命令路由 (commands/router.ts)
  │       解析命令 + 参数 → 调用对应 handler → 渲染结果
  └─ 否 → 自然语言处理
          ├─ 意图识别（关键词匹配）
          │   "暂停" / "先放一下" → park 当前任务
          │   "继续" / "接着做"   → resume 最近 parked 任务
          │   "现在该做什么"      → 显示 dashboard
          │   "记住：..."        → 添加偏好
          └─ 默认 → 作为任务指令发送给执行器
```

### 4.4 斜杠命令路由

```typescript
// commands/router.ts
interface CommandHandler {
  name: string;
  aliases: string[];
  description: string;
  execute(args: string[], context: CommandContext): Promise<CommandResult>;
}

class CommandRouter {
  private handlers: Map<string, CommandHandler> = new Map();

  register(handler: CommandHandler): void
  parse(input: string): { command: string; args: string[] } | null
  execute(input: string, context: CommandContext): Promise<CommandResult>
}

interface CommandContext {
  taskEngine: TaskEngine;
  memoryEngine: MemoryEngine;
  orchestration: OrchestrationEngine;
  executor: ExecutorAdapter;
  currentTaskId: string | null;
}

interface CommandResult {
  type: 'text' | 'table' | 'dashboard' | 'confirm';
  content: string;
  data?: any;
}
```

### 4.5 启动盘面渲染

```typescript
// 启动时自动调用
function renderStartupDashboard(dashboard: Dashboard): string {
  const lines = [
    `┌─ Metaclaw v1.0 ${'─'.repeat(40)}┐`,
    `│ 你有 ${dashboard.summary.active} 个活跃任务，${dashboard.summary.blocked} 个 Blocked。`,
  ];

  if (dashboard.priorityTask) {
    const t = dashboard.priorityTask;
    lines.push(`│ 建议优先：#${t.id} ${t.title}`);
    t.reasons.forEach(r => lines.push(`│   → ${r}`));
  }

  lines.push(`└${'─'.repeat(50)}┘`);
  return lines.join('\n');
}
```

---

## 5. 入口与初始化 (`src/index.ts`)

```typescript
#!/usr/bin/env node

import { resolve } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { createDatabase } from './storage/database';
import { TaskRepo } from './storage/task-repo';
import { PreferenceRepo } from './storage/preference-repo';
import { ObservationRepo } from './storage/observation-repo';
import { TaskEngine } from './core/task-engine';
import { MemoryEngine } from './core/memory-engine';
import { OrchestrationEngine } from './core/orchestration';
import { createExecutor } from './executor/factory';
import { loadConfig } from './utils/config';
import { renderApp } from './tui/app';

async function main() {
  // 1. 初始化目录
  const metaclawDir = resolve(homedir(), '.metaclaw');
  const snapshotDir = resolve(metaclawDir, 'snapshots');
  if (!existsSync(metaclawDir)) mkdirSync(metaclawDir, { recursive: true });
  if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true });

  // 2. 加载配置
  const config = loadConfig(resolve(metaclawDir, 'config.yaml'));

  // 3. 初始化数据库
  const db = createDatabase(resolve(metaclawDir, 'metaclaw.db'));

  // 4. 初始化 Repos
  const taskRepo = new TaskRepo(db);
  const prefRepo = new PreferenceRepo(db);
  const obsRepo = new ObservationRepo(db);

  // 5. 初始化引擎
  const taskEngine = new TaskEngine(taskRepo, snapshotDir);
  const memoryEngine = new MemoryEngine(prefRepo, obsRepo);
  const orchestration = new OrchestrationEngine(taskEngine);

  // 6. 初始化执行器
  const executor = createExecutor({
    command: config.executor?.command ?? 'codex',
    timeout: config.executor?.timeout ?? 300,
  });

  // 7. 检查执行器可用性
  if (!(await executor.isAvailable())) {
    console.error(`错误：未找到 ${config.executor?.command ?? 'codex'} 命令。请先安装对应执行器。`);
    process.exit(1);
  }

  // 8. 启动 TUI
  renderApp({ taskEngine, memoryEngine, orchestration, executor });
}

main().catch(console.error);
```

---

## 6. 构建与开发

### package.json 脚本

```json
{
  "name": "metaclaw",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "metaclaw": "./dist/index.js"
  },
  "scripts": {
    "dev": "tsup --watch",
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit",
    "start": "node dist/index.js"
  }
}
```

### tsup.config.ts

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  external: ['better-sqlite3'],
});
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

---

## 7. 配置文件格式

### ~/.metaclaw/config.yaml

```yaml
# Metaclaw V1 配置
version: 1

executor:
  command: codex           # 默认执行器；可改为 claude
  timeout: 300             # 执行超时（秒）

orchestration:
  reminder_enabled: true   # 是否启用主动提醒
  reminder_throttle: 300   # 提醒最小间隔（秒）
  top_k_preferences: 5     # 偏好召回数量上限

ui:
  language: zh-CN          # 界面语言
  dashboard_on_start: true # 启动时显示盘面
```

---

## 8. 模块依赖关系

```
                    ┌──────────┐
                    │  index   │  入口
                    └────┬─────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    ┌──────────┐  ┌────────────┐  ┌──────────┐
    │   TUI    │  │  Commands  │  │ Executor │
    │ (ink)    │  │  (router)  │  │ Adapter  │
    └────┬─────┘  └─────┬──────┘  └────┬─────┘
         │              │              │
         └──────────────┼──────────────┘
                        ▼
              ┌───────────────────┐
              │    Core Engines   │
              │ Task / Memory /   │
              │ Orchestration     │
              └────────┬──────────┘
                       ▼
              ┌───────────────────┐
              │   Storage Layer   │
              │ Repos + SQLite    │
              └───────────────────┘
```

依赖方向严格自上而下：
- TUI / Commands / Executor → Core Engines → Storage
- Core Engines 之间可互相引用（Orchestration 依赖 TaskEngine）
- Storage 层不依赖任何上层模块

---

## 9. 测试策略

### 单元测试

| 模块 | 测试重点 | Mock 策略 |
|------|----------|-----------|
| TaskEngine | 状态机迁移合法性、快照生成、恢复摘要 | Mock TaskRepo |
| MemoryEngine | 三次确认流程、召回排序、作用域优先级 | Mock Repos |
| Orchestration | 优先级评分、盘面生成、建议原因 | Mock TaskEngine |
| CommandRouter | 命令解析、参数提取、错误处理 | Mock Engines |

### 集成测试

使用 SQLite in-memory 数据库（`:memory:`），测试完整流程：
- 创建任务 → 挂起 → 恢复 → 完成
- 偏好观察 → 候选 → 确认 → 召回
- 执行器调用（Mock child_process）

### vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/storage/**'],
    },
  },
});
```

---

## 10. 分阶段实施路线

### Phase 1：基础骨架（预计 3-5 天）

目标：跑通 "创建任务 → 查看任务" 最小闭环

- [ ] 项目初始化（package.json / tsconfig / tsup / vitest）
- [ ] 类型定义 (`src/core/types.ts`)
- [ ] Storage 层：database.ts + migrations.ts + task-repo.ts
- [ ] TaskEngine：create / transition / findById
- [ ] 最小 TUI：启动 → 输入 → 创建任务 → 显示确认
- [ ] 基础命令路由：`/tasks`、`/task <id>`

### Phase 2：任务连续性（预计 3-5 天）

目标：实现 Continuity 核心能力

- [ ] TaskEngine：park / resume / block / unblock
- [ ] 快照生成与存储
- [ ] 恢复摘要生成
- [ ] 命令：`/task <id> pause/resume/block/unblock`
- [ ] 自然语言意图识别（"暂停"、"继续"）
- [ ] 单元测试：状态机迁移全覆盖

### Phase 3：偏好记忆（预计 3-5 天）

目标：实现 Memory 核心能力

- [ ] Storage：preference-repo.ts + observation-repo.ts
- [ ] MemoryEngine：observe / confirm / reject / recall
- [ ] 三次确认流程
- [ ] 召回算法（精确匹配 + 关键词 + 作用域排序）
- [ ] 命令：`/memory` 全套
- [ ] TUI：偏好确认交互（y/n/e）
- [ ] 单元测试：召回排序、确认流程

### Phase 4：主动编排（预计 2-3 天）

目标：实现 Guidance 核心能力

- [ ] OrchestrationEngine：优先级评分、盘面生成、建议生成
- [ ] 启动时盘面渲染
- [ ] 任务完成后推荐下一个
- [ ] `/dashboard` 命令
- [ ] 建议原因可解释性
- [ ] 提醒节流机制

### Phase 5：执行器集成（预计 2-3 天）

目标：打通默认 codex 执行闭环，并保留 claude 兼容

- [ ] ExecutorAdapter 接口
- [ ] ClaudeCodeAdapter 实现
- [ ] 上下文注入（任务 + 偏好）
- [ ] 结果聚合回流到任务视图
- [ ] 错误处理（超时、中断、空输出）
- [ ] 执行器可用性检查

### Phase 6：打磨与集成测试（预计 2-3 天）

目标：端到端可用

- [ ] 集成测试：完整用户场景
- [ ] 配置文件加载
- [ ] 错误提示优化
- [ ] 边界情况处理
- [ ] npm link 本地测试
- [ ] README 编写

---

## 11. 关键设计约束与注意事项

1. **状态机严格性**：所有状态迁移必须经过 `VALID_TRANSITIONS` 校验，非法迁移直接抛错
2. **偏好不猜测**：三次确认原则是硬约束，不允许绕过；用户显式 "记住" 除外
3. **执行器隔离**：Metaclaw 不直接执行任务，所有执行通过 Adapter 接口，为 V2 多执行器预留
4. **结果必须回流**：执行器输出不直接展示，必须经过 Metaclaw 聚合后以任务视图呈现
5. **主动但不烦人**：提醒有节流机制（默认 5 分钟间隔），同一建议不重复推送
6. **执行器默认完整权限**：无论使用 codex 还是 claude，默认都以完整权限运行，不额外弹授权确认
7. **本地优先**：所有数据存储在 `~/.metaclaw/`，不依赖网络，不上传数据

---

## 12. 相关文档

- `metaclaw-os_prd_v2.md`：产品需求（场景、验收标准、指标）
- `metaclaw-os_tech_design_v1.md`：技术设计（数据模型、SQLite Schema、执行器方案）
- `metaclaw-os_tui_spec_v1.md`：TUI 交互规范（命令体系、盘面布局、对话流）
