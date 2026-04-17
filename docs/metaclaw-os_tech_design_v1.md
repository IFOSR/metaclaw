# Metaclaw Tech Design V1

## 1. 目标

本文档描述 Metaclaw V1 的技术设计，服务于以下产品目标：
- 任务对象化与状态机管理
- 任务挂起 / 恢复 / 阻塞 / 解除阻塞
- 单执行器（默认 codex cli，兼容 claude code）集成
- 偏好记忆的 V1 技术实现
- TUI 运行所需的本地存储与数据结构

PRD 见：`metaclaw-os_prd_v2.md`
TUI 规范见：`metaclaw-os_tui_spec_v1.md`
多任务调度与恢复专项设计见：`docs/plans/2026-04-16-multitask-scheduler-and-resume-design.md`

---

## 2. 技术边界

### V1 技术边界
- 单机本地运行
- 本地 SQLite 持久化
- 单执行器：默认 codex cli，兼容 claude code
- 手动唤醒 Blocked 任务
- 偏好召回仅支持精确匹配 + 关键词匹配
- 不引入本地 embedding / 向量索引
- 不引入后台 daemon

### V1.5 / V2 预留方向
- 向量召回
- 偏好覆盖率反馈调置信
- 文件系统监控
- 时间触发唤醒
- 多执行器注册与路由

---

## 3. 系统模块

### 3.1 Task Engine
负责：
- 任务创建
- 状态迁移
- 快照生成
- 恢复摘要生成
- 阻塞 / 解除阻塞
- 优先级信号维护

### 3.2 Memory Engine
负责：
- 偏好观察记录
- 候选偏好提取
- 三次确认原则
- 偏好确认 / 删除 / 编辑
- 偏好召回
- 作用域与优先级裁决

### 3.3 Orchestration Engine
负责：
- 任务盘面生成
- Ready / Blocked 任务分类
- 优先级排序
- 主动建议生成
- 会话内提醒节流

### 3.4 Scheduler Engine
负责：
- 接收用户提交并归一化为任务调度请求
- 维护当前运行中的任务和候选任务集合
- 决定立即执行、排队、抢占、恢复
- 在执行完成 / 阻塞 / 失败 / 解除阻塞后触发下一轮调度

### 3.5 ResumeContextBuilder
负责：
- 为新任务或恢复任务构建统一执行上下文
- 统一装配任务快照、任务历史、跨任务历史、命中的偏好与恢复原因
- 区分 `fresh / resume-parked / resume-blocked / follow-up` 四种执行模式

### 3.6 Executor Adapter
负责：
- 调用 codex cli 或 claude code
- 注入任务上下文
- 注入相关偏好
- 获取输出结果
- 捕获执行失败 / 超时 / 中断

### 3.7 Storage Layer
负责：
- SQLite 持久化
- 快照文件存储
- 本地配置加载

---

## 4. 任务状态机

### 4.1 状态集合
- `CREATED`
- `READY`
- `RUNNING`
- `PARKED`
- `BLOCKED`
- `DONE`
- `ARCHIVED`
- `CANCELLED`

### 4.2 合法迁移
- `CREATED -> READY`
- `READY -> RUNNING`
- `RUNNING -> PARKED`
- `RUNNING -> BLOCKED`
- `RUNNING -> DONE`
- `PARKED -> READY`
- `PARKED -> CANCELLED`
- `BLOCKED -> READY`
- `DONE -> ARCHIVED`

### 4.2.1 状态语义
- `READY`：任务已满足基本执行条件，进入候选队列
- `RUNNING`：当前唯一占用执行器的任务
- `PARKED`：任务可恢复但当前未执行，常见来源为用户暂停、被高优任务抢占、执行被安全中断
- `BLOCKED`：任务依赖未满足，不参与调度，但不影响系统继续接收和调度其他任务

### 4.3 快照生成时机
- 任务从 `RUNNING -> PARKED`
- 用户主动请求保存当前进度
- 执行器中断但已有部分结果
- 当前任务被更高优先级任务抢占

---

## 5. 数据模型

## 5.1 任务对象
```json
{
  "id": "task_xxx",
  "title": "整理行业分析结论",
  "goal": "基于三份报告产出一页分析摘要",
  "status": "PARKED",
  "summary": "已读完前两份报告，第三份未处理",
  "lastSnapshot": {
    "done": ["提取了报告A核心观点", "整理了报告B与A的差异"],
    "pending": ["阅读报告C", "合并为一页摘要"],
    "nextStep": "先处理报告C，再统一整理结论",
    "pauseReason": "用户切换到临时任务"
  },
  "resources": ["file://report-a.pdf", "file://report-b.pdf", "file://report-c.pdf"],
  "dependencies": [],
  "prioritySignals": {
    "dueAt": null,
    "isReady": true,
    "progressRatio": 0.7,
    "blocksOthers": false,
    "idleHours": 18
  },
  "injectedPreferences": ["pref_001", "pref_003"],
  "lastSchedulingReason": "当前无更高优任务，继续成本最低",
  "lastInterruptionReason": "被高优任务抢占",
  "interruptionCount": 1,
  "createdAt": "2026-04-10T09:00:00+08:00",
  "updatedAt": "2026-04-11T15:00:00+08:00"
}
```

## 5.2 阻塞依赖对象
```json
{
  "taskId": "task_xxx",
  "type": "manual",
  "description": "等待客户补充证据文件",
  "status": "waiting",
  "createdAt": "2026-04-10T14:00:00+08:00"
}
```

## 5.3 主动建议对象
```json
{
  "taskId": "task_xxx",
  "type": "resume_suggestion",
  "reason": ["输入已齐", "任务已完成70%", "继续推进的上下文成本最低"],
  "recommendedAction": "继续阅读报告C并完成摘要",
  "generatedAt": "2026-04-11T09:00:00+08:00"
}
```

## 5.4 偏好对象
```json
{
  "id": "pref_001",
  "type": "contact",
  "scope": "contact",
  "subject": "张总",
  "content": "使用正式敬语，必须抄送法务王某某",
  "status": "active",
  "confidence": 0.95,
  "occurrenceCount": 8,
  "sourceTasks": ["task_003", "task_007", "task_012"],
  "lastUsedAt": "2026-04-10T16:00:00+08:00",
  "confirmedAt": "2026-03-20T10:00:00+08:00",
  "createdAt": "2026-03-15T09:00:00+08:00"
}
```

## 5.5 运行态对象
```json
{
  "runningTaskId": "task_xxx",
  "readyTaskIds": ["task_101", "task_102"],
  "blockedTaskIds": ["task_201"],
  "parkedTaskIds": ["task_301"],
  "lastEvent": "task_xxx 被 task_101 抢占"
}
```

## 5.6 执行上下文包
```json
{
  "mode": "resume-parked",
  "taskBrief": {
    "id": "task_xxx",
    "title": "整理行业分析结论",
    "goal": "基于三份报告产出一页分析摘要",
    "status": "parked",
    "summary": "已读完前两份报告，第三份未处理"
  },
  "resumeContext": {
    "lastProgress": "报告 A/B 已完成",
    "pauseReason": "被高优任务抢占",
    "nextStep": "继续阅读报告 C",
    "schedulingReason": "当前无更高优任务，继续成本最低"
  },
  "memoryContext": [],
  "historyContext": {
    "taskTurns": [],
    "sessionTurns": [],
    "relatedTurns": []
  },
  "materialContext": {
    "resources": ["file://report-a.pdf"]
  },
  "executionInstructions": [
    "这是恢复执行，不要从头重做",
    "优先从上次未完成步骤继续"
  ]
}
```

---

## 6. SQLite Schema

```sql
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    goal TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    summary TEXT,
    snapshot_json TEXT,
    resources_json TEXT,
    dependencies_json TEXT,
    priority_json TEXT,
    injected_prefs_json TEXT,
    last_scheduling_reason TEXT,
    last_interruption_reason TEXT,
    interruption_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE preferences (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    scope TEXT NOT NULL,
    subject TEXT,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'observed',
    confidence REAL DEFAULT 0,
    occurrence_count INTEGER DEFAULT 1,
    source_tasks TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT,
    confirmed_at TEXT
);

CREATE TABLE preference_usage (
    id TEXT PRIMARY KEY,
    preference_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    injected_at TEXT NOT NULL,
    was_overridden BOOLEAN DEFAULT FALSE
);

CREATE TABLE observations (
    id TEXT PRIMARY KEY,
    pattern TEXT NOT NULL,
    occurrence_count INTEGER DEFAULT 1,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    source_tasks TEXT,
    promoted_to_preference_id TEXT
);

CREATE TABLE interactions (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    user_input TEXT,
    system_output TEXT,
    executor_used TEXT,
    created_at TEXT NOT NULL
);
```

---

## 7. 偏好记忆技术方案（V1）

## 7.1 作用域模型
- `global`
- `project`
- `contact`
- `task-local`

> `one-off` 不进入长期偏好表，属于当前请求指令。

## 7.2 优先级裁决
默认优先级：
`one-off > task-local > contact/project > global`

冲突处理：
- 联系人沟通任务：优先 `contact`
- 项目产出规范：优先 `project`
- 无法可靠判断：提示冲突并以用户当前指令为准

## 7.3 候选提取机制
任务完成后，从 interaction 记录中提取重复模式：
- 第一次：写入 `observations`
- 第二次：标记为候选
- 第三次：进入待确认列表
- 用户确认后：写入 `preferences`

## 7.4 召回机制
V1 召回流程：
1. 从当前输入提取关键词
2. 按 `subject` 做精确匹配
3. 按 `content` 做关键词匹配
4. 只保留 `confirmed / active`
5. 按作用域优先级排序
6. 截取 Top-K（默认 5）

### 7.4.1 恢复时的记忆装配顺序
恢复任务时，记忆注入不能独立于任务恢复上下文存在。装配顺序固定为：
1. 当前输入显式要求
2. 任务局部偏好 / 任务历史中重复使用的偏好
3. 联系人 / 项目级偏好
4. 全局偏好

恢复执行的上下文构建顺序固定为：
1. 任务骨架
2. 恢复摘要
3. 命中的偏好
4. 当前任务近期历史
5. 关联历史任务
6. 材料列表
7. 当前用户输入
8. 执行指令

## 7.5 V1.5 预留
- embedding 字段
- 向量索引
- 被覆盖多次后自动调低置信度
- 长期未使用自动衰减

---

## 8. 调度与执行器集成

## 8.1 设计原则
- V1 单执行器
- 默认使用 codex cli，兼容 claude code
- 程序化调用执行器
- 将 Metaclaw 视为调度层，执行器视为执行层

## 8.1.1 调度规则
- 输入框始终可用，不因任务运行而禁用
- 同一时刻只允许一个任务处于 `RUNNING`
- 所有 `READY` 任务构成候选集合，由 Scheduler Engine 选择最高优先级任务执行
- 当新任务满足抢占条件时，当前 `RUNNING` 任务生成快照并转为 `PARKED`，新任务转为 `RUNNING`
- `BLOCKED` 任务不参与调度；当前运行任务一旦阻塞，调度器立即选择下一个 `READY` 任务

## 8.1.2 中断语义
- 用户取消：终止执行，任务可转 `CANCELLED` 或 `PARKED`
- 抢占中断：调用 `abort()`，任务转 `PARKED`，不记为执行失败
- 超时中断：调用 `abort()`，任务转 `PARKED`，记录失败原因以供恢复判断

## 8.2 上下文注入格式
```text
[Metaclaw 执行上下文]
模式：{fresh|resume-parked|resume-blocked|follow-up}
任务：{任务标题}
目标：{用户目标}
当前状态：{当前状态}

恢复摘要：
- 上次做到：{lastProgress}
- 暂停/中断原因：{pauseReason}
- 当前未完成：{pending}
- 建议下一步：{nextStep}
- 本次恢复原因：{schedulingReason}

相关偏好：
- [{scope}] {preference}（命中原因：{reason}）

关联材料：{材料列表}

当前任务对话：
[1] 用户: xxx
    助手: xxx（截断至150字）

会话近期上下文：
[任务#xxx] 用户: xxx
           助手: xxx（截断至150字）

关联历史：
[任务#xxx] 用户: xxx
           助手: xxx（截断至150字）

用户指令：{当前输入}

执行要求：
- 若为恢复执行，不要从头重做
- 优先沿用已完成结论与未完成步骤
- 若材料仍不足，再明确指出缺什么
```

## 8.2.1 对话上下文召回机制（Session Context Recall）

Executor 每次调用都是无状态的，对话上下文由 Metaclaw 管理和注入。采用三层筛选策略：

**第一层：当前任务历史（必注入）**
- 当前 taskId 的 interactions 记录，按时间正序
- 上限：最近 10 轮

**第二层：会话近期历史（时间窗口）**
- 当前 session 内、非当前任务的最近交互
- 通过 interactions 表的 `session_id` 字段筛选
- 上限：最近 5 轮
- 场景：同一会话内跨任务引用（"你刚才说的..."）

**第三层：关键词关联历史（按需召回）**
- 从用户当前输入提取关键词（去停用词，长度 >= 2）
- 在历史 interactions 的 user_input 中做 LIKE 匹配
- 上限：最多 3 条，与前两层去重
- 场景：跨会话引用（"上次讨论的 search engine"）

**Token 控制：**
- 每条 system_output 截断至 150 字符
- 总注入上下文预估：~2000-3000 tokens

## 8.3 错误处理
需要覆盖：
- 超时
- 非零退出
- 执行中断
- 输出为空
- 输出不符合预期格式

## 8.4 执行器配置示例
```yaml
# ~/.metaclaw/config.yaml
executor:
  command: codex
  timeout: 300
```

---

## 9. 本地存储结构

```text
~/.metaclaw/
├── config.yaml
├── metaclaw.db
└── snapshots/
    ├── task_001/
    │   ├── snapshot_v1.json
    │   └── snapshot_v2.json
    └── task_002/
        └── snapshot_v1.json
```

---

## 10. 未来技术演进

### V1.5
- 本地 embedding 模型
- 向量检索
- 反馈闭环调置信

### V2
- 文件监控 daemon
- 时间触发器
- 多执行器注册与路由
- 外部数据源偏好提取
