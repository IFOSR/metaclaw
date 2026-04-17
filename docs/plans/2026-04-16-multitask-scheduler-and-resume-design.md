# Metaclaw 多任务调度与恢复设计

**日期：** 2026-04-16  
**状态：** 已确认设计  
**关联文档：**
- `docs/metaclaw-os_prd_v2.md`
- `docs/metaclaw-os_tech_design_v1.md`
- `docs/metaclaw-os_tui_spec_v1.md`
- `docs/metaclaw-os_implementation_v1.md`

---

## 1. 设计目标

这次设计解决 3 个根本问题：

1. 当前实现把“执行器正在运行”错误地放大成“整个输入框不可用”，破坏多任务心智。
2. 现有状态机有 `running / parked / blocked`，但没有真正的调度器，状态无法驱动执行顺序。
3. 现有恢复逻辑更像“状态切换”，缺少对任务快照、历史和记忆的统一装配。

V1 的目标不是并发执行多个执行器，而是在单执行器前提下，把多任务调度、任务恢复和记忆注入统一起来。

---

## 2. 核心原则

- 输入框永远可用。
- 状态是任务级，不是会话级。
- 单执行器不等于单任务。
- `blocked` 只阻止该任务继续执行，不阻止系统继续接活。
- 高优任务可以抢占当前任务，但被抢占任务必须能自动恢复。
- 恢复任务必须自动加载之前的任务状态、历史和命中的记忆。

---

## 3. 状态模型

### 3.1 任务状态

- `created`
  刚创建，尚未进入调度。
- `ready`
  已满足基本执行条件，进入候选队列。
- `running`
  当前唯一占用执行器的任务。
- `parked`
  可恢复但当前未执行，来源通常是用户暂停、被抢占或安全中断。
- `blocked`
  依赖未满足，不参与调度。
- `done`
  当前目标完成。
- `cancelled`
  用户明确取消。
- `archived`
  历史归档。

### 3.2 关键迁移

- `created -> ready`
- `ready -> running`
- `running -> parked`
- `running -> blocked`
- `running -> done`
- `parked -> ready`
- `blocked -> ready`

### 3.3 状态语义

- `ready` 本质上就是“排队候选”，V1 不单独新增 `queued` 状态。
- `parked` 是被抢占后的标准落点。
- `blocked` 是调度信号，不是会话级锁。

---

## 4. 调度器设计

### 4.1 新增模块：`SchedulerEngine`

职责：

- 接收用户输入并归一化为任务调度请求。
- 维护当前运行态：谁在 `running`，哪些任务在 `ready / parked / blocked`。
- 决定立即执行、排队、抢占、恢复。
- 在执行前触发上下文构建。
- 在任务完成、失败、阻塞、解除阻塞后触发下一轮调度。

### 4.2 运行态

```ts
interface RuntimeState {
  runningTaskId: string | null;
  readyTaskIds: string[];
  blockedTaskIds: string[];
  parkedTaskIds: string[];
  lastEvent: string | null;
}
```

### 4.3 调度规则

1. 当前无 `running`
   - 从所有 `ready` 任务中选最高优先级任务执行。

2. 当前有 `running`，新任务到来
   - 若新任务未达到抢占条件，则保留在 `ready`。
   - 若新任务满足抢占条件，则当前任务生成快照并转 `parked`，调用 `abort()`，新任务转 `running`。

3. 当前任务进入 `blocked`
   - 立即释放执行器。
   - 立刻选择下一个 `ready` 任务。

4. 当前任务完成或失败
   - 标记为 `done` 或 `parked`。
   - 再从 `ready` 任务中选下一个。

### 4.4 抢占规则

V1 采用单执行器、可抢占模型，但不能因为轻微分差频繁中断。建议：

- `candidateScore >= currentScore + PREEMPT_DELTA`
- 或命中硬规则：
  - 用户显式指定高优
  - 任务阻塞其他任务
  - 截止时间极近

推荐常量：

```ts
const PREEMPT_DELTA = 5;
const MANUAL_PRIORITY_BONUS = 8;
const MANUAL_RESUME_BONUS = 6;
```

### 4.5 抢占流程

1. 读取当前 `running` 任务。
2. 生成快照，写明当前进度与中断原因。
3. 当前任务 `running -> parked`。
4. 调用 `executor.abort()`。
5. 新任务 `ready -> running`。
6. 为新任务构建执行上下文。
7. 调用执行器。

说明：抢占不是失败，而是正常调度行为。

---

## 5. 恢复与记忆统一装配

### 5.1 新增模块：`ResumeContextBuilder`

职责：

- 为每次执行构建统一的 `ExecutionContextBundle`。
- 区分 `fresh / resume-parked / resume-blocked / follow-up` 4 种模式。
- 把任务快照、任务历史、相关历史和偏好记忆装配成稳定顺序的上下文。

### 5.2 Bundle 结构

```ts
interface ExecutionContextBundle {
  mode: 'fresh' | 'resume-parked' | 'resume-blocked' | 'follow-up';
  taskBrief: TaskBrief;
  resumeContext?: ResumeContext;
  memoryContext: MemoryContext;
  historyContext: HistoryContext;
  materialContext: MaterialContext;
  executionInstructions: string[];
}
```

### 5.3 恢复时装配顺序

1. 任务骨架
2. 恢复摘要
3. 命中的偏好
4. 当前任务近期历史
5. 关联历史
6. 材料列表
7. 当前用户输入
8. 执行指令

### 5.4 记忆优先级

恢复任务时，偏好优先级为：

`当前输入 > task-local / 任务恢复上下文 > contact/project > global`

这保证：

- 用户当前显式要求优先级最高。
- 恢复任务能延续该任务已有工作方式。
- 全局偏好不会压过任务局部连续性。

### 5.5 4 种执行模式

- `fresh`
  新任务首次执行。
- `resume-parked`
  用户暂停或被抢占后恢复。
- `resume-blocked`
  阻塞解除后恢复，需强调“之前为什么卡住、现在补齐了什么”。
- `follow-up`
  从终态任务 fork 的新延续任务，继承旧任务结论但不重跑旧任务目标。

---

## 6. TUI 交互设计

### 6.1 运行区与输入区分离

主界面至少由 3 个区域组成：

1. 历史输出区
2. 常驻输入区
3. 轻量运行摘要区

输入区永远可编辑，不再被 `isExecuting` 替换成全局占位。

### 6.2 运行摘要区

示例：

```text
当前执行: #21 合同风险对比
待执行: 3
阻塞: 1
```

### 6.3 调度事件文案

需要明确输出：

- 任务创建并进入候选队列
- 当前任务被抢占并挂起
- 当前任务被标记阻塞
- 自动切换到下一个可执行任务
- 恢复任务时的摘要

---

## 7. 任务清单设计

`/dashboard` 是建议视图，`/tasks` 是全量任务视图。

V1 至少支持：

- `/tasks`
- `/tasks active`
- `/tasks ready`
- `/tasks parked`
- `/tasks blocked`
- `/tasks done`
- `/task <id>`

默认 `/tasks` 要按分组展示：

```text
当前执行
  #21 [RUNNING] 合同风险对比

待执行
  #30 [READY] 客户回复草稿

已挂起
  #12 [PARKED] 行业分析摘要

已阻塞
  #15 [BLOCKED] 起诉书草稿
```

---

## 8. 数据模型补充

建议在 `Task` 上新增：

- `lastSchedulingReason`
- `lastInterruptionReason`
- `interruptionCount`

如果范围允许，再补：

- `lastStartedAt`
- `lastPausedAt`
- `lastBlockedAt`

这些字段用于：

- 调度解释性
- 恢复摘要
- 抢占后的可理解性

---

## 9. V1 测试要求

最少覆盖：

- 输入框在任务运行时仍可继续录入
- 新任务进入 `ready` 队列
- 高优任务触发抢占
- 被抢占任务 `running -> parked`
- `blocked` 任务自动切换到下一个 `ready`
- 恢复任务时自动注入快照、历史和偏好
- `/tasks` 正确分组展示

---

## 10. 结论

V1 的正确心智不是“聊天框外面包一层任务标签”，而是“一个始终可派单的任务调度台”：

- 调度器决定跑谁
- 恢复构建器决定怎么继续跑
- Memory 决定带什么用户习惯与约束
- TUI 负责让这些行为对用户可见、可理解、可控制
