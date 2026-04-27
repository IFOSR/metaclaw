# MetaClaw 优化方案：Hermes 借鉴、自进化与高精度上下文召回

> **方案状态：最新优化方案**  
> **用途：后续 MetaClaw 具体实施以本文档为准**  
> **范围：保留 MetaClaw Task-first 核心架构，在不覆盖现有差异化能力的前提下，引入 Hermes agent 的长期记忆、技能沉淀、自检调度、召回治理与上下文注入优化。**

---

## 1. 背景与目标

MetaClaw 当前已经具备几个关键差异化能力：

1. **Task-first 架构**：任务是第一实体，所有执行、调度、恢复、记忆都围绕 Task 展开。
2. **TaskEngine 状态机**：支持 ready / running / parked / blocked / done / archived / cancelled 等任务生命周期。
3. **SchedulerEngine 调度**：支持任务抢占、park/resume、blocked 后调度下一任务。
4. **Recall Review**：偏好和任务记忆可在执行前进入人工 review，而不是无脑注入。
5. **ExecutorAdapter**：MetaClaw 作为协调层，执行器只是 worker，不能绕过 MetaClaw 主链路。
6. **TUI / Feishu 分离**：不同通道有独立输出策略，飞书通道不能反向污染 TUI 行为。

本优化方案的目标不是把 MetaClaw 改造成 Hermes，也不是用 Hermes 替换 MetaClaw，而是：

> 借鉴 Hermes agent 的长期记忆、技能沉淀、历史召回、自检调度和工具治理机制，增强 MetaClaw 的“持续学习、可恢复执行、低污染上下文注入、自我优化”能力。

核心优化目标：

1. **保持 MetaClaw-first**：不覆盖 TaskEngine、SchedulerEngine、Recall Review、ExecutorAdapter、TUI/Feishu 分离等核心能力。
2. **提升历史任务召回精准度**：低置信历史不注入，中置信历史需确认，高置信历史也必须可解释。
3. **区分恢复型上下文与参考型上下文**：恢复同一 blocked/parked 任务时不能只注入摘要，必须注入完整恢复包；相似历史只注入最小必要经验卡片。
4. **建立自进化闭环**：观察执行过程 → 生成候选经验 → Review → 晋升为记忆/技能/策略 → 安全注入 → 效果评估。
5. **可审计、可回滚、可反馈**：所有自动学习和召回决策都应有记录、理由和用户反馈通道。

---

## 2. MetaClaw-first 架构原则

### 2.1 不允许被覆盖的核心能力

以下能力是 MetaClaw 的核心差异点，任何 Hermes-like 能力只能作为增强层接入，不能替换：

| 核心能力 | 不允许发生的覆盖 | 正确增强方式 |
|---|---|---|
| TaskEngine | 不能让外部 agent 直接绕过任务状态机执行 | 外部能力只能通过 task context / executor adapter 进入 |
| SchedulerEngine | 不能用 Hermes cron 替代任务调度 | cron/self-review 只能生成 report/candidate/proposal |
| park/resume | 不能把恢复简化为普通历史摘要 | 必须构建 Resume Context Pack |
| Recall Review | 不能让 skill/history recall 静默全量注入 | 新召回也必须经过 policy / threshold / review |
| ExecutorAdapter | 不能让 Hermes tools 直接执行 MetaClaw 任务 | tools/skills 只能作为上下文或候选执行建议 |
| TUI / Feishu 分离 | 不能用统一 delivery 覆盖通道行为 | 各通道独立格式化、截断、分段、过滤策略 |
| MemoryEngine | 不能用 markdown memory 替代 SQLite source of truth | markdown/skill 只能作为 view 或沉淀产物 |

### 2.2 新能力的接入边界

新增能力必须遵守：

```text
candidate-first → review/policy → approved → inject/execute → audit/evaluate
```

也就是说：

- 可以自动观察，但不能自动永久写入高权重记忆。
- 可以自动生成技能候选，但不能自动修改执行策略。
- 可以自动召回历史，但低/中置信不能静默注入。
- 可以周期自检，但不能绕过 SchedulerEngine 直接执行任务。

---

## 3. Hermes agent 可借鉴能力拆解

### 3.1 长期记忆 Memory

Hermes 的 memory 机制可以长期保存用户偏好、环境事实、工具经验和项目约定。MetaClaw 可借鉴的不是存储形式，而是记忆治理原则：

1. 记忆必须是稳定事实，不保存临时任务进度。
2. 用户偏好优先级高于环境事实。
3. 写入记忆前需要确认或达到明确证据阈值。
4. 记忆应被动态选择注入，而不是全量注入。

MetaClaw 对应增强：

```text
MemoryEngine 继续作为 source of truth
新增 MemoryCandidate / Promotion / Audit 流程
长期记忆注入必须走 RecallPolicyService
```

### 3.2 技能沉淀 Skills

Hermes 的 skill 是可复用工作流。MetaClaw 可引入类似概念，但不能替代 Task：

```text
Task 是执行对象
Skill 是复用方法
Memory 是偏好/事实
Guidance 是调度建议
```

技能来源：

1. 成功完成复杂任务后的执行轨迹总结。
2. 多次重复出现的调试/验证流程。
3. 用户明确要求“以后按这个流程”。
4. 失败后修正出的稳定方法。

技能晋升流程：

```text
execution trace → skill candidate → safety scan → user/review approval → skill store → future recall
```

### 3.3 历史会话召回 Session Search

Hermes 的 session_search 适合跨会话找历史线索，但 MetaClaw 不应直接把 session_search 结果塞进 executor。正确方式：

```text
历史线索 → task-level candidate → relevance ranker → review/policy → context bundle
```

### 3.4 定时自检 Cron / Scheduler

Hermes cron 可以周期执行任务。MetaClaw 可借鉴周期自检，但不能替代 SchedulerEngine。

允许的定时任务：

- 生成待 review 的记忆候选。
- 检查长期 blocked 任务。
- 汇总重复失败模式。
- 生成技能候选。
- 生成健康报告。

不允许：

- 未经 SchedulerEngine 直接执行用户任务。
- 自动向外部发送高风险消息。
- 自动修改核心配置或策略。

---

## 4. 总体优化架构

建议新增五个增强层：

```text
┌──────────────────────────────────────────────┐
│                MetaClaw 主链路                │
│ TaskEngine → SchedulerEngine → ExecutorAdapter │
│ MemoryEngine → RecallReview → PromptBuilder    │
└──────────────────────────────────────────────┘
                  ▲
                  │ candidate / approved context only
                  │
┌──────────────────────────────────────────────┐
│              Hermes-like 增强层               │
│ 1. Reflection Engine                          │
│ 2. Skill Candidate Store                      │
│ 3. Task Relevance Ranker                      │
│ 4. Context Bundle Builder                     │
│ 5. Self Review Scheduler                      │
└──────────────────────────────────────────────┘
```

### 4.1 Reflection Engine

负责从执行结果中观察：

- 成功模式
- 失败原因
- 用户纠正
- 重复操作
- 可沉淀流程
- 可转成长期记忆的偏好

输出不是直接记忆，而是 candidate。

### 4.2 Skill Candidate Store

保存候选技能：

```ts
interface SkillCandidate {
  id: string;
  title: string;
  trigger: string;
  workflow: string[];
  filesTouched: string[];
  verification: string[];
  pitfalls: string[];
  sourceTaskIds: string[];
  status: 'candidate' | 'approved' | 'rejected' | 'archived';
}
```

### 4.3 Task Relevance Ranker

负责历史任务召回精准度治理。

输入：当前任务、用户指令、候选历史任务。  
输出：带 score/reason/riskFlags 的候选列表。

### 4.4 Context Bundle Builder

负责把不同模式的上下文组织成结构化 prompt bundle。

关键点：

```text
恢复同一任务 ≠ 参考相似任务
```

### 4.5 Self Review Scheduler

基于 SchedulerEngine 之外的低风险周期自检：

- 不执行用户任务。
- 只生成报告和候选项。
- 需要人工或 policy 才能晋升。

---

## 5. 历史任务召回精准度治理

### 5.1 当前问题

现有历史任务召回容易出现不相关候选，主要原因包括：

1. 关键词 / bigram 匹配过宽。
2. 只看 interaction user_input，缺少 task-level 语义。
3. LLM rerank 候选信息不足，只看短输入而非任务全貌。
4. 缺少硬过滤和最低阈值。
5. 召回结果一旦进入 `relatedTurns`，容易直接污染 prompt。

### 5.2 治理原则

```text
宁可少召回，不要错召回。
低置信不注入。
中置信必须确认。
高置信也必须可解释。
没有清晰相关性理由的候选直接过滤。
```

### 5.3 多阶段召回管线

```text
Stage 0: 显式意图识别
Stage 1: 候选生成
Stage 2: 硬过滤
Stage 3: 多维打分
Stage 4: LLM structured rerank
Stage 5: 阈值分级
Stage 6: Review / Auto Apply Policy
Stage 7: Context Bundle 注入
Stage 8: 用户反馈与审计
```

### 5.4 候选生成

候选来源：

1. 当前任务历史。
2. 显式引用任务，例如 `#task_xxx`。
3. 同项目任务。
4. FTS/BM25 文本召回。
5. embedding 语义召回。
6. LLM rerank 后候选。

候选生成只负责“找可能相关”，不负责决定注入。

### 5.5 硬过滤规则

以下候选直接过滤：

1. 不同项目且没有共享实体。
2. 只命中泛词，如“问题、任务、之前、继续、优化、修复、怎么、方案”。
3. 当前意图与历史任务意图完全不同，且没有共享实体。
4. 历史任务 cancelled / failed / blocked 且未解决，除非用户显式指定。
5. 无法生成明确相关性理由。

### 5.6 多维打分

建议新增：

```ts
interface TaskRelevanceScore {
  taskId: string;
  finalScore: number;
  lexicalScore: number;
  semanticScore: number;
  entityScore: number;
  intentScore: number;
  recencyScore: number;
  statusScore: number;
  artifactScore: number;
  negativeScore: number;
  reason: string;
  riskFlags: string[];
}
```

建议权重：

```text
finalScore =
  0.25 * semanticScore
+ 0.20 * lexicalScore
+ 0.20 * entityScore
+ 0.15 * intentScore
+ 0.10 * artifactScore
+ 0.05 * statusScore
+ 0.05 * recencyScore
- negativeScore
```

### 5.7 阈值分级

| 分数 | 等级 | 处理 |
|---:|---|---|
| >= 80 | high | 可自动注入，但必须显示采用理由 |
| 65-79 | medium | 默认不注入，进入用户确认 |
| 50-64 | low | 默认不展示，可在 more 中查看 |
| < 50 | rejected | 直接丢弃，仅写 audit |

### 5.8 用户反馈学习

支持交互：

```text
y          采用全部可确认候选
n          不采用
s 1 2      只采用指定编号
r          查看详情
hide 2     标记第 2 条未来少召回
irrelevant 2 标记第 2 条不相关
more       查看弱相关候选
```

反馈写入：

```ts
interface RecallFeedback {
  id: string;
  queryHash: string;
  taskId: string;
  candidateTaskId: string;
  decision: 'accepted' | 'rejected' | 'hidden' | 'irrelevant';
  reason?: string;
  createdAt: string;
}
```

---

## 6. 任务上下文召回与注入分层设计

这是本优化方案的关键修正：

> 历史任务上下文不能统一按“摘要”注入。必须先判断召回目的，再决定注入深度。

### 6.1 召回模式分类

```ts
type RecallMode =
  | 'resume_current_task'
  | 'resume_blocked_task'
  | 'resume_parked_task'
  | 'explicit_task_reference'
  | 'similar_task_reference'
  | 'session_recent_context';
```

| 模式 | 是否同一任务 | 目标 | 注入深度 |
|---|---:|---|---|
| `resume_current_task` | 是 | 继续当前任务 | 完整恢复包 |
| `resume_blocked_task` | 是 | 解决阻塞并继续 | 完整恢复包 + 阻塞诊断 |
| `resume_parked_task` | 是 | 从暂停点恢复 | 完整恢复包 |
| `explicit_task_reference` | 否/可能 | 用户明确指定参考某任务 | 中等上下文 |
| `similar_task_reference` | 否 | 相似经验参考 | 最小经验卡片 |
| `session_recent_context` | 可能 | 保持当前对话连续性 | 最近少量 turn |

### 6.2 ContextDepth

```ts
type ContextDepth =
  | 'none'
  | 'summary'
  | 'reference'
  | 'resume'
  | 'full';
```

| 场景 | depth | 说明 |
|---|---|---|
| 无相关历史 | none | 不注入 |
| 相似任务参考 | summary | 只注入经验卡片 |
| 用户显式引用历史任务 | reference | 注入关键决策、文件、验证、坑点 |
| parked/blocked 恢复 | resume | 注入完整恢复包 |
| 用户明确要求完整历史 | full | 注入压缩后的完整任务脉络和关键原文 |

默认不要 full。只有用户明确要求，或 snapshot 缺失、恢复失败、上下文严重不足时才启用 full expansion。

---

## 7. 恢复型上下文：Resume Context Pack

### 7.1 使用场景

适用于：

```text
resume_current_task
resume_blocked_task
resume_parked_task
```

这些场景中，历史任务不是参考资料，而是当前任务本体，因此不能只注入摘要。

### 7.2 必须召回内容

恢复型上下文必须包含：

1. **Task Brief**：taskId、title、goal、status、priority、summary。
2. **Latest Snapshot**：lastProgress、done、pending、decisions、risks、nextStep。
3. **Blocked / Parked Reason**：blockedReason、pauseReason、interruptionReason、schedulingReason。
4. **User Last Intent**：最近 3-5 轮用户关键指令。
5. **Execution Trail**：最近执行过什么、改过哪些文件、跑过哪些命令、失败/成功原因。
6. **Materials / Resources**：关联文件、URL、材料摘要。
7. **Artifacts**：产物路径、类型、是否需要继续修改。
8. **Acceptance Criteria**：验收命令、用户明确要求、完成标准。
9. **Restore Instructions**：恢复时必须遵守的执行指令。

### 7.3 类型设计

```ts
interface ResumeContextPack {
  mode: 'resume_current_task' | 'resume_blocked_task' | 'resume_parked_task';

  taskBrief: {
    taskId: string;
    title: string;
    goal: string;
    status: string;
    priority?: string;
    summary?: string;
  };

  latestSnapshot?: {
    createdAt: string;
    lastProgress: string;
    done: string[];
    pending: string[];
    decisions: string[];
    risks: string[];
    nextStep: string;
    pauseReason?: string;
    blockedReason?: string;
  };

  interruption: {
    reason?: string;
    blockedReason?: string;
    schedulingReason?: string;
  };

  recentUserTurns: Array<{
    createdAt: string;
    userInput: string;
    assistantOutputSummary: string;
  }>;

  executionTrail: Array<{
    createdAt: string;
    action: string;
    filesChanged: string[];
    commandResults: string[];
    outcome: 'success' | 'failed' | 'blocked' | 'partial';
  }>;

  materials: Array<{
    pathOrUrl: string;
    type: 'file' | 'url' | 'note' | 'unknown';
    summary?: string;
  }>;

  artifacts: Array<{
    path: string;
    kind?: string;
    summary?: string;
  }>;

  acceptanceCriteria: string[];
  restoreInstructions: string[];
}
```

### 7.4 Blocked Task 特殊诊断

当任务状态为 blocked 时，恢复包必须额外包含：

```text
[阻塞诊断]
- 阻塞类型：等待用户确认 / 缺材料 / 测试失败 / 外部依赖 / 权限不足 / 不确定需求
- 阻塞原因原文
- 解除阻塞条件
- 当前是否已满足
- 恢复后的第一步
```

如果无法判断解除阻塞条件，executor 应先询问或产出 clarification request，而不是硬继续。

### 7.5 恢复型注入示例

```text
[任务恢复上下文包]

恢复模式：resume_blocked_task
当前任务：#task_123 修复 MetaClaw 飞书回复截断
目标：飞书通道必须发送 executor 完整正文，不发送思考过程，长正文连续分段发送且不丢信息。
当前状态：blocked

[中断/阻塞原因]
- 阻塞原因：等待确认是否允许修改飞书通道输出策略。
- 本次恢复原因：用户已确认继续修复。

[最近快照]
- 上次做到：已定位飞书通道存在长文本截断问题。
- 已完成：
  1. 阅读 src/integrations/feishu-app.ts
  2. 确认飞书回复格式化入口
  3. 确认需要分段发送
- 未完成：
  1. 提取 executor 完整正文
  2. 增加 splitForFeishu 分段发送
  3. 增加测试覆盖
- 下一步：修改 feishu-app.ts 并运行集成测试。

[关键用户要求]
1. 不要发摘要，要发 executor 完整正文。
2. 不要发 thinking/reasoning。
3. TUI 行为不能变。
4. 如果太长，就连续分几段发，不要丢信息。

[执行轨迹]
- 已检查文件：
  - src/integrations/feishu-app.ts
  - tests/integrations/feishu-app.test.ts
- 当前要继续：
  - 更新测试
  - 修复 split 逻辑
  - 运行 npm test / lint / build

[恢复执行要求]
- 只继续当前任务，不要重新设计无关模块。
- 优先完成未完成项。
- 如发现快照与当前代码冲突，以当前代码为准，并说明差异。
```

---

## 8. 参考型上下文：Reference Context Pack 与 Minimal Reference Card

### 8.1 显式引用任务：Reference Context Pack

适用于用户明确说：

```text
参考 #task_xxx
按照之前飞书截断那次来
用上次那个修法
```

召回内容：

1. task brief。
2. task outcome。
3. key decisions。
4. changed files。
5. verification commands。
6. pitfalls。
7. artifacts。
8. user constraints。

注入示例：

```text
[显式引用的历史任务]

用户要求参考：#task_123 飞书回复截断修复

该历史任务的可复用经验：
- 问题：飞书通道单条消息长度限制导致正文截断。
- 方案：将完整 executor answer 用 splitForFeishu 分段发送。
- 涉及文件：
  - src/integrations/feishu-app.ts
  - tests/integrations/feishu-app.test.ts
- 验证命令：
  - npm test -- tests/integrations/feishu-app.test.ts
  - npm run lint
  - npm run build
- 注意：
  - 不改变 TUI。
  - 不发送 thinking/reasoning。
  - 每段拼接后必须等于原始正文。

使用边界：
- 这是参考经验，不是当前任务本体。
- 如果当前代码或用户要求与历史不同，以当前任务为准。
```

### 8.2 相似任务参考：Minimal Reference Card

适用于系统自动找到相似历史任务。

只注入：

1. 标题。
2. 相关原因。
3. 可复用步骤。
4. 涉及文件。
5. 验证方式。
6. 坑点。

示例：

```text
[可能相关的历史经验]

1. #task_123 飞书回复截断修复，相关性 87/100
   采用原因：同属 MetaClaw 飞书通道，问题均为长文本回复丢失。
   可复用：
   - 长文本应分段发送，不能硬截断。
   - 分段后拼接结果必须等于原文。
   - 过滤 thinking/reasoning。
   相关文件：
   - src/integrations/feishu-app.ts
   - tests/integrations/feishu-app.test.ts

使用边界：
- 这是相似经验，不是当前任务要求。
- 不得把历史约束覆盖当前用户最新指令。
```

---

## 9. Prompt 注入结构设计

### 9.1 新 prompt 结构

`prompt-builder.ts` 应从自由拼接 `relatedTurns` 升级为结构化 context bundle 注入。

推荐结构：

```text
[Metaclaw 执行上下文]

[0. 系统边界]
你是 Metaclaw 调度的执行器。
不要把历史参考误认为当前任务。
当前任务目标和用户最新指令优先级最高。

[1. 当前任务]
任务ID：...
标题：...
目标：...
状态：...
执行模式：...

[2. 用户最新指令]
...

[3. 恢复上下文]
仅 resume mode 出现。
包含 snapshot / blocked reason / pending / next step / execution trail。

[4. 已确认的记忆/偏好]
来自 MemoryEngine / RecallReview 已通过项。

[5. 相关历史任务]
只包含通过过滤和确认的历史任务。
每条标明：
- 关系类型：恢复 / 显式引用 / 相似参考
- 相关性分数
- 使用边界

[6. 材料和产物]
resources / artifacts

[7. 当前任务对话]
当前 task 最近 turns

[8. 当前会话近期上下文]
session recent turns

[9. 执行要求]
...
```

### 9.2 优先级规则

上下文冲突时优先级固定为：

```text
系统边界
> 用户最新指令
> 当前任务目标
> 恢复快照
> 用户确认的记忆/偏好
> 显式引用历史任务
> 相似历史经验
> 会话近期上下文
```

### 9.3 使用边界声明

每类历史上下文都必须带边界：

恢复上下文：

```text
以下是同一任务的恢复上下文，优先用于继续未完成项。
如果恢复上下文与用户最新指令冲突，以用户最新指令为准。
```

显式引用历史任务：

```text
以下是用户明确要求参考的历史任务。
它不是当前任务本体，只能复用其中适配当前目标的经验。
```

相似历史任务：

```text
以下是系统筛选出的相似历史经验，置信度有限。
不得把它当成当前任务要求；如有冲突，以当前任务为准。
```

---

## 10. ExecutionContextBundle 设计

建议把现有 bundle 扩展为：

```ts
interface ExecutionContextBundle {
  mode: ExecutionMode;

  taskBrief: TaskBrief;

  userInstruction: {
    latest: string;
    explicitConstraints: string[];
  };

  resumeContext?: ResumeContextPack;

  memoryContext: {
    resolvedPreferences: ResolvedPreference[];
  };

  historicalContext: {
    resumeTask?: ResumeContextPack;
    explicitReferences: ReferenceContextPack[];
    similarReferences: MinimalReferenceCard[];
    filteredOut: FilteredRecallSummary[];
  };

  materialContext: MaterialContext;

  historyContext: {
    currentTaskTurns: ConversationTurn[];
    sessionRecentTurns: ConversationTurn[];
  };

  executionInstructions: string[];
}
```

重点：

```text
relatedTurns 不再是一个自由列表。
historicalContext 必须区分 resume / explicit / similar。
```

---

## 11. Context Budget 设计

### 11.1 Resume Mode 预算

恢复任务时，预算优先级：

1. 最新用户指令：必须完整。
2. 当前任务 brief：必须完整。
3. latest snapshot：必须完整。
4. blocked/parked reason：必须完整。
5. pending/done/nextStep：必须完整。
6. 最近用户 turns：最多 5 轮，可压缩助手输出。
7. execution trail：最近 3 次。
8. materials/artifacts：路径完整，内容摘要。
9. 相似历史参考：最多 1 条，且只摘要。

### 11.2 Reference Mode 预算

1. 最新用户指令。
2. 当前任务 brief。
3. 用户显式引用的 reference pack。
4. 已确认偏好。
5. materials/artifacts。
6. 当前任务对话。
7. 相似任务卡片最多 2 条。

### 11.3 Similar Reference Mode 预算

1. 最新用户指令。
2. 当前任务 brief。
3. 已确认偏好。
4. 相似任务卡片最多 1-2 条。
5. 当前任务最近 turns。

---

## 12. 数据模型建议

### 12.1 task_memory_cards

用于任务级召回，避免 interaction-level 误召回。

```sql
CREATE TABLE IF NOT EXISTS task_memory_cards (
  task_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  summary TEXT NOT NULL,
  project TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  entities_json TEXT NOT NULL DEFAULT '[]',
  intent_type TEXT,
  key_decisions_json TEXT NOT NULL DEFAULT '[]',
  pitfalls_json TEXT NOT NULL DEFAULT '[]',
  verification_json TEXT NOT NULL DEFAULT '[]',
  artifact_paths_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
```

### 12.2 recall_feedback

```sql
CREATE TABLE IF NOT EXISTS recall_feedback (
  id TEXT PRIMARY KEY,
  query_hash TEXT NOT NULL,
  task_id TEXT,
  candidate_task_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
```

### 12.3 memory_recall_events 扩展

建议记录：

```text
candidate_task_id
relevance_score
relevance_reasons
filter_stage
decision
user_feedback
false_positive
injected
context_depth
recall_mode
```

---

## 13. 现有代码接入点

### 13.1 `src/core/context-recaller.ts`

现状：返回 `ConversationTurn[]`，包含 task / session / keyword / llm。

优化：

1. 保留旧接口兼容。
2. 新增结构化接口：

```ts
buildTaskContext(input): Promise<TaskContextRecallResult>
```

返回：

```ts
interface TaskContextRecallResult {
  mode: RecallMode;
  resumeContext?: ResumeContextPack;
  explicitReferences: ReferenceContextPack[];
  similarReferences: MinimalReferenceCard[];
  sessionRecentTurns: ConversationTurn[];
  currentTaskTurns: ConversationTurn[];
  filteredOut: Array<{
    taskId: string;
    title: string;
    reason: string;
    score: number;
  }>;
}
```

### 13.2 `src/core/hybrid-memory-recaller.ts`

优化：

1. 引入 `TaskRelevanceRanker`。
2. merge 后先 hard filter / rerank，再返回 candidates。
3. 低于阈值的候选只写 audit，不进入 prompt。

### 13.3 `src/core/recall-policy-service.ts`

优化：

1. 新增 history recall policy。
2. auto apply 不再是粗粒度 `task_memory` 全局生效。
3. 自动采用必须满足：

```text
same project + same intent + score >= 80 + no risk flags
```

### 13.4 `src/core/recall-review-builder.ts`

优化 review card 展示：

```text
score
confidence
matchedSignals
negativeSignals
riskFlags
contextDepth
recallMode
```

### 13.5 `src/executor/prompt-builder.ts`

优化：

1. 拆分 append 函数：

```ts
appendCurrentTaskSection()
appendLatestUserInstruction()
appendResumeContextPack()
appendMemoryContext()
appendHistoricalReferences()
appendMaterialContext()
appendConversationHistory()
appendExecutionInstructions()
```

2. `relatedTurns` 降级为 legacy，不再作为主上下文。
3. 只接受 gated / approved context bundle。

### 13.6 `src/storage/migrations.ts`

新增或扩展表：

- `task_memory_cards`
- `recall_feedback`
- `memory_recall_events` 字段扩展
- 可选 FTS5 索引

### 13.7 `src/session/metaclaw-session.ts`

优化交互：

- 支持 recall review 中的 `hide` / `irrelevant` / `more`。
- 恢复任务前展示“已加载恢复上下文包”。
- 区分“任务恢复上下文”和“历史参考上下文”。

---

## 14. 用户交互设计

### 14.1 恢复任务提示

```text
┌─ 任务恢复上下文 ─────────────────────────────┐
│ 准备恢复：#task_123 修复 MetaClaw 飞书回复截断 │
│ 状态：blocked                                 │
│ 已加载：                                      │
│ ✓ 最新快照                                    │
│ ✓ 阻塞原因                                    │
│ ✓ 最近 5 轮用户指令                            │
│ ✓ 最近 3 次执行轨迹                            │
│ ✓ 相关文件/产物                                │
│                                              │
│ 本次不会注入弱相关历史任务。                    │
│ 输入 y 继续，r 查看恢复详情，n 取消。             │
└──────────────────────────────────────────────┘
```

### 14.2 历史参考提示

```text
┌─ 历史参考上下文 ─────────────────────────────┐
│ 当前任务不是恢复旧任务，将只参考相似历史经验。     │
│ 已选择：#task_123 飞书回复截断修复               │
│ 注入内容：关键决策、涉及文件、验证命令、坑点       │
│ 不会注入完整历史对话。                           │
└──────────────────────────────────────────────┘
```

### 14.3 中置信候选确认

```text
┌─ 可能相关的历史任务 ───────────────────────┐
│ 以下历史可能有帮助，但置信度不足，默认不注入 │
│ 1. #task_123 飞书回复截断修复 score=74      │
│    原因：同属飞书通道，但问题是格式化而非截断 │
│ 2. #task_456 TUI 输出清洗 score=69          │
│    原因：同属输出过滤，但通道不同             │
│                                            │
│ 输入：                                    │
│ y        采用全部                         │
│ n        不采用                           │
│ s 1 2    只采用指定编号                    │
│ r        展开详情                         │
│ hide 2   标记第 2 条未来少召回              │
└──────────────────────────────────────────┘
```

---

## 15. 分阶段实施路线

### Phase 1：召回安全阈值与 Prompt 分层

目标：最快降低 context 污染，并修复恢复任务只靠摘要的问题。

改动：

1. 在 `prompt-builder.ts` 中拆分恢复上下文、历史参考、当前任务对话。
2. 提高相似任务召回阈值。
3. `relatedTurns` 不再无差别注入。
4. blocked/parked 恢复必须注入 Resume Context Pack。
5. review card 显示 score/reason/contextDepth。

验收：

- blocked task 恢复 prompt 中必须包含 snapshot、blocked reason、pending、nextStep。
- 相似历史任务不会作为恢复上下文出现。
- 低置信历史不进入 executor prompt。

### Phase 2：TaskRelevanceRanker

目标：建立可解释、多维度、可测试的任务相关性评分。

新增：

```text
src/core/task-relevance-ranker.ts
tests/core/task-relevance-ranker.test.ts
```

验收：

- 同项目 + 同文件 + 同错误类型任务 score >= 80。
- 只有泛词命中的任务 score < 50。
- 不同项目无共享实体任务被过滤。

### Phase 3：Recall Feedback

目标：用户反馈反哺召回。

新增：

```text
recall_feedback
hide / irrelevant / more 交互
```

验收：

- 用户标记 irrelevant 后，同类 query 不再自动采用该候选。
- accepted 历史任务后续在相似 query 中适当升权。

### Phase 4：Task Memory Card 与 FTS

目标：从 interaction-level 召回升级到 task-level 召回。

新增：

```text
task_memory_cards
task_memory_cards_fts
```

验收：

- 可基于 title/goal/summary/entities/key_decisions/pitfalls 检索。
- 不再依赖单轮 user_input LIKE 作为主要召回依据。

### Phase 5：Skill Candidate 与 Self Review

目标：形成 Hermes-like 自进化闭环。

新增：

```text
ReflectionEngine
SkillCandidateStore
SelfReviewScheduler
```

验收：

- 复杂任务完成后可生成 skill candidate。
- candidate 需要 review 才能晋升。
- 周期自检只生成报告，不直接执行用户任务。

---

## 16. 测试与验收标准

### 16.1 召回精准度指标

```text
Precision@1 >= 0.90
Precision@3 >= 0.85
Context Pollution Rate <= 0.10
用户 reject rate 持续下降
```

### 16.2 恢复完整性指标

恢复 blocked/parked 任务时：

1. prompt 必须包含 latest snapshot。
2. prompt 必须包含 blocked/parked reason。
3. prompt 必须包含 pending 和 nextStep。
4. prompt 必须包含最近关键用户要求。
5. prompt 必须包含验收标准或明确说明缺失。

### 16.3 安全边界验收

1. 相似历史不得覆盖用户最新指令。
2. 自动召回不得绕过 Recall Review policy。
3. 自进化 candidate 不得自动变成长期策略。
4. Feishu / TUI 输出策略保持独立。
5. 不得把 credentials / tokens / secrets 注入 prompt 或文档；敏感值统一 `[REDACTED]`。

### 16.4 测试用例建议

新增 fixtures：

```text
tests/fixtures/task-recall-eval.json
```

覆盖：

1. 同项目、同文件、同 bug 类型，应该高分召回。
2. 只有泛词相同，应该过滤。
3. 恢复 blocked task，必须生成 Resume Context Pack。
4. 相似历史任务只能生成 Minimal Reference Card。
5. 用户显式引用任务，应生成 Reference Context Pack。
6. 用户标记 irrelevant 后，下次降权或过滤。

---

## 17. 最终执行原则

后续具体实施按照本文档执行，优先级如下：

1. **先保护上下文质量**：低置信不注入，恢复任务必须完整恢复包。
2. **再提升召回准确率**：TaskRelevanceRanker、Task Memory Card、FTS/embedding。
3. **再做反馈学习**：recall_feedback、用户 reject/accept 反哺。
4. **最后做自进化闭环**：Reflection、Skill Candidate、Self Review。

一句话总结：

> MetaClaw 的优化方向不是“记住更多”，而是“在正确的任务阶段，注入正确粒度、可解释、可审计、可回滚的上下文”。

---

## 18. 后续实施文件清单

预计主要改动文件：

```text
src/core/context-recaller.ts
src/core/hybrid-memory-recaller.ts
src/core/recall-policy-service.ts
src/core/recall-review-builder.ts
src/core/task-relevance-ranker.ts          # 新增
src/core/context-bundle-builder.ts         # 可新增或扩展 ResumeContextBuilder
src/executor/prompt-builder.ts
src/session/metaclaw-session.ts
src/storage/migrations.ts
src/storage/memory-recall-event-repo.ts
src/storage/recall-feedback-repo.ts        # 新增
tests/core/task-relevance-ranker.test.ts   # 新增
tests/core/context-bundle-builder.test.ts  # 新增或对应现有 builder 测试
tests/executor/prompt-builder.test.ts
tests/fixtures/task-recall-eval.json       # 新增
```

实施时必须遵守 TDD：先写失败测试，再实现，再跑测试、lint、build。
