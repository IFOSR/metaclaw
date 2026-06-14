# MetaClaw Task OS 架构与策略升级方案

日期：2026-06-14

## 1. 核心结论

MetaClaw 下一轮架构升级的主线不应继续优先放在 GatewayRuntime、Executor Discovery 或多客户端平台化上。

当前更关键的问题是：

1. **任务越来越多后，如何高效检索历史任务、任务产物、任务经验和相似上下文。**
2. **复杂任务到来后，如何由 MetaClaw 判断是否需要多执行器协作，并负责拆分、调度、汇总和验收。**
3. **如何继续保持 conversation / task 的边界清晰，避免任务系统被闲聊、解释、状态查询污染。**

所以本轮升级目标应定义为：

**把 MetaClaw 从“有任务系统的 session agent”升级为“以任务为中心的本地 AI Task OS”。**

这不是要重写现有系统。当前 MetaClaw 已经有很多正确的骨架：

- `TaskEngine`：任务状态机。
- `TaskRepo`：任务持久化。
- `SchedulerEngine`：调度、抢占、恢复。
- `OrchestrationEngine`：任务优先级和建议。
- `MetaclawSession`：当前主 runtime。
- `classifyNaturalLanguageInput()`：conversation / task_control / durable_task 初步分流。
- `planTaskExecution()`：reuse-existing / fork-follow-up / blocked 判断。
- `ExecutorRouter`：选择 executor。
- `MemoryEngine` / `HybridMemoryRecaller` / `TaskMemoryCardRepo`：任务记忆和召回雏形。

下一步应该做的是：

- 收敛策略边界。
- 增加任务检索索引层。
- 增加复杂任务执行策略层。
- 增加多执行器 work unit 编排层。
- 增加汇总与验证层。

明确不做：

- 不做原先讨论里的 Phase F。
- 本轮不做 Executor Discovery。
- 本轮不做 GatewayRuntime 收敛。
- 本轮不做 Slack / Twitter / WeCom / DingTalk 多客户端平台化。
- 本轮不重写 `MetaclawSession`。

## 2. 为什么 MetaClaw 必须区分 Conversation 和 Task

对用户来说，conversation 和 task 不应该成为显式负担。用户只是自然说话。

但对 MetaClaw 来说，这个边界是系统语义的根。

```text
conversation = answer now
task         = manage work over time
```

Conversation 适合：

- 问答。
- 解释。
- 澄清。
- 状态查询。
- 短反馈。
- 不需要恢复、不需要调度、不需要验收的即时响应。

Task 适合：

- 需要多步执行。
- 需要调用 executor。
- 可能被 blocked / parked / resumed。
- 有资源、材料、产物、状态、快照。
- 后续要检索、复用、追踪。
- 需要进入 scheduler 或多 executor 编排。

如果不区分，会出现严重问题：

- “解释一下这个概念”被误建成任务，任务池被污染。
- “当前有哪些任务？”被错误派发给 executor。
- 历史任务检索混入大量闲聊，召回质量下降。
- Scheduler 不知道什么该排队，什么只是即时回答。
- Blocked / parked / resume 没有稳定对象。
- 多 executor 编排不知道应该拆什么。

所以 MetaClaw 要做 task-oriented agent，就必须保留这个边界。

但边界不能变成用户负担。正确产品体验是：

```text
用户：解释一下 FTS5
MetaClaw：直接解释，不建任务

用户：基于这个解释写一份架构方案并保存到 docs
MetaClaw：创建任务，执行，产出文件，记录任务记忆

用户：继续刚才那个
MetaClaw：根据 focus context 和历史任务判断是继续 conversation，还是继续 task
```

## 3. 当前架构诊断

### 3.1 做得好的地方

MetaClaw 已经有 task OS 的核心骨架。

```text
User Input
    │
    ▼
MetaclawSession
    │
    ├── pending confirmations
    ├── task clear / status / resume / unblock
    ├── route: conversation | task_control | durable_task
    ├── intent: new | reference existing task
    ├── planTaskExecution()
    ├── TaskEngine create / transition
    ├── Memory recall
    ├── Scheduler submit / dispatch
    ├── ExecutorRouter
    └── Executor execute
```

已有正确能力：

- conversation 输入不会创建 task。
- natural language task status query 可以直接读取 MetaClaw 状态，不必调用 executor。
- follow-up conversation work 可以创建新 task，并继承 conversation context。
- done / archived / cancelled 任务不会被直接重跑，而是 fork follow-up。
- parked / blocked / running 有不同恢复策略。
- route decision 和 executor decision 已经有可解释输出。

### 3.2 主要问题

当前还不是成熟 task OS，主要问题有四个。

#### 问题 1：任务边界策略分散

相关逻辑分散在：

- `src/core/task-routing.ts`
- `src/session/session-helpers.ts`
- `src/session/metaclaw-session.ts`
- `src/core/executor-router.ts`
- `LlmBridge`

这不是方向错，而是还没有形成稳定策略管线。继续往 `MetaclawSession` 里加 if，会越来越难维护。

#### 问题 2：任务检索还不能支撑规模增长

当前任务主数据在 SQLite，但相似任务召回仍存在低效路径：

- `TaskRepo.findAll()` 后内存过滤。
- `TaskMemoryEmbeddingRepo.findAll()` 后全量计算 cosine similarity。
- `TaskRelevanceRanker` 需要候选集，但候选集来源还不够索引化。
- `TaskMemoryCardRepo.search()` 是内存式文本匹配思路，不是 FTS-first。

任务少时可用，任务多时会退化。

#### 问题 3：已有 executor race 不是多执行器协作

当前 research race 是：

```text
Hermes / Pi 同时跑
    │
    ▼
第一个完成者胜出
    │
    ▼
abort 其他 executor
```

这适合竞速，不适合复杂任务协作。

复杂任务需要的是：

```text
拆分 work units
    │
    ├── 调研
    ├── 实现
    ├── 审查
    └── 汇总
        │
        ▼
MetaClaw 聚合、冲突检测、验收
```

#### 问题 4：缺少“执行策略”层

当前有：

- 是不是任务。
- 关联哪个任务。
- 选哪个 executor。

但缺少一个明确问题：

**这个任务是单 executor 够了，还是需要 multi-executor work units？**

这个判断不能塞进 `ExecutorRouter`。`ExecutorRouter` 只应该选 executor，不应该决定任务是否拆分。

## 4. 新目标架构

目标架构：

```text
User Input
    │
    ▼
Input Boundary Pipeline
    │
    ├── InputRouter
    │     conversation | task_control | durable_task
    │
    ├── TaskIntentResolver
    │     new | reference existing task
    │
    ├── ExecutionPlanner
    │     reuse-existing | fork-follow-up | blocked
    │
    ▼
Task Runtime
    │
    ├── TaskEngine
    ├── SchedulerEngine
    ├── OrchestrationEngine
    └── MemoryEngine
    │
    ▼
Task Retrieval Layer
    │
    ├── TaskSearchIndex
    ├── HybridTaskRetriever
    └── TaskRelationGraph
    │
    ▼
Execution Strategy Layer
    │
    ├── ExecutionStrategyPlanner
    │     single_executor | multi_executor
    │
    ├── WorkUnitPlanner
    │     only when multi_executor
    │
    ├── MultiExecutorOrchestrator
    │
    └── Aggregator + Verification
    │
    ▼
Executor Layer
    │
    ├── codex-cli
    ├── deepseek-tui
    ├── hermes-agent
    ├── pi-agent
    └── custom executor
```

关键点：

- 不新增重复的 `TaskExplainer`。
- 不让 `ExecutorRouter` 负责拆任务。
- 不把 every prompt 都变成 task。
- 不把 work unit 默认变成 durable task。
- 不让多 executor 编排绕过 TaskEngine / SchedulerEngine。

## 5. 策略边界设计

### 5.1 InputRouter：是不是任务

职责：

```text
判断用户输入属于：

conversation
task_control
durable_task
```

已有基础：

- `classifyNaturalLanguageInput()`
- `llmBridge.resolveRoute()`
- task status query special handling
- task clear / resume / unblock handling

建议改造方向：

- 保留现有函数名或轻量封装，不新增复杂模块。
- 把 route decision 的证据结构化记录下来。
- 增加 `shouldCreateDurableTask` 的显式 reason。

判定标准：

```text
durable_task =
  explicit work intent
  + expected artifact/result
  + needs execution or persistence
```

强信号：

- 产物词：报告、方案、文档、代码、补丁、表格、清单、总结、邮件、PR。
- 执行动词：调研、实现、修复、整理、生成、写入、跑测试、对比、验证。
- 持久上下文：继续、恢复、基于文件、结合历史、参考上次、保存到。
- 外部资源：文件、链接、仓库、网页、材料。
- 验收语义：输出、交付、最终结论、可执行步骤、测试通过。

默认策略：

- 明确即时问答：conversation。
- 明确任务控制：task_control。
- 明确产物/执行：durable_task。
- 不确定：conversation first，必要时轻量追问。

### 5.2 TaskIntentResolver：新任务还是历史任务

职责：

```text
如果是 durable_task 或 task_control：
  判断用户指的是新任务，还是历史/当前任务。
```

已有基础：

- `llmBridge.resolveIntent()`
- focus context
- recent tasks
- persisted last task continuation

需要增强：

- 不再只依赖 recent tasks。
- 接入 `HybridTaskRetriever` 的候选结果。
- 每个候选带 provenance 和 reason。

输出：

```ts
type TaskIntentDecision =
  | {
      type: "new";
      reason: string;
    }
  | {
      type: "reference";
      taskId: string;
      confidence: number;
      reason: string;
      evidence: Array<{
        source: "focus" | "explicit_id" | "fts" | "semantic" | "relation" | "recent";
        summary: string;
      }>;
    };
```

### 5.3 ExecutionPlanner：复用、跟进、还是 blocked

职责：

```text
对一个已经选中的 task，判断：
  reuse-existing
  fork-follow-up
  blocked
```

已有基础：

- `planTaskExecution()`

建议：

- 保持它的职责窄。
- 不让它判断 executor。
- 不让它判断 work units。
- 可以把它从 `session-helpers.ts` 独立成更明确的 `execution-planner.ts`，但不是必须。

### 5.4 ExecutorRouter：默认 executor

职责：

```text
给一个执行请求选 primary executor。
```

已有基础：

- `ExecutorRouter`
- `ExecutorProfile`
- route events
- hard rules

边界：

- 不判断是不是 task。
- 不判断是否拆分。
- 不做 aggregation。
- 不覆盖 repo mutation hard rule。

### 5.5 ExecutionStrategyPlanner：单执行器还是多执行器

这是新增层，但不是 Task Explainer。

它只回答：

**当前任务是否需要拆成多个 work units 执行？**

输入必须来自已有模块：

```ts
type ExecutionStrategyInput = {
  task: Task;
  userPrompt: string;
  executionPlan: ExecutionPlan;
  routeDecision: ExecutorRouteDecision;
  retrievedTasks: TaskMemoryCandidate[];
  resources: string[];
};
```

输出：

```ts
type ExecutionStrategy =
  | {
      mode: "single_executor";
      reason: string;
      executorName: string;
    }
  | {
      mode: "multi_executor";
      reason: string;
      workUnits: ExecutionWorkUnit[];
      aggregation: AggregationPlan;
    };
```

## 6. 什么是复杂任务

复杂任务不等于 prompt 长，也不等于用户语气复杂。

复杂任务是指：**单个 executor 一次执行很可能无法可靠完成，或者缺少独立验证会产生明显风险的任务。**

进入 multi-executor 的强信号：

### 6.1 多能力域

同一任务同时需要多个明显不同能力：

```text
外部调研 + 本地代码修改
资料整理 + 架构设计 + 文档落地
市场研究 + 客户邮件 + 风险审查
```

### 6.2 强阶段依赖

后一步依赖前一步产物：

```text
先调研竞品
再总结差异
再改 README
再生成对外说明
```

### 6.3 高风险验证

任务包含高风险动作，需要独立 review：

- repo mutation。
- 客户外发。
- 删除数据。
- 生产环境。
- 财务/法律/合同承诺。
- 大规模重构。

### 6.4 多来源证据合成

任务要求综合：

- 历史任务。
- 当前材料。
- 外部搜索。
- 已有产物。
- 代码仓库。

### 6.5 用户显式要求多视角

例如：

- “让不同 agent 分别做”
- “并行调研和实现”
- “给我两个方案再综合”
- “一个负责实现，一个负责 review”

保持 single executor 的情况：

- 单一 repo bugfix。
- 单一技术解释。
- 单一市场调研报告。
- 单一文档整理。
- 单一代码 review。
- prompt 很长但能力域单一。

## 7. Work Unit 设计

Work unit 是复杂任务内部的执行单元。

它不是默认的新 task。

```text
Task = 用户可见、可恢复、可调度、可检索的 durable work item
WorkUnit = 一个 Task 内部的执行步骤
```

只有当 work unit 需要长期跟踪、单独恢复、单独阻塞、用户单独管理时，才提升为真正的 `Task`。

类型：

```ts
type ExecutionWorkUnit = {
  id: string;
  title: string;
  goal: string;
  executorHint: string;
  dependsOn: string[];
  inputs: {
    taskId: string;
    resources: string[];
    recalledTaskIds: string[];
  };
  expectedOutput: "analysis" | "patch" | "artifact" | "review" | "summary";
  acceptance: string[];
  riskLevel: "low" | "medium" | "high";
};
```

执行图：

```text
Main Task
    │
    ├── wu_1 research
    │       executor: hermes-agent / pi-agent
    │
    ├── wu_2 implementation
    │       executor: codex-cli
    │       dependsOn: wu_1
    │
    ├── wu_3 review
    │       executor: deepseek-tui / codex-cli
    │       dependsOn: wu_2
    │
    └── aggregation
            executor: MetaClaw runtime
            output: final result + task memory card
```

## 8. 任务检索索引层

任务检索是本轮最优先的基础设施。

### 8.1 当前问题

当前已经有：

- `tasks`
- `interactions`
- `task_memory_cards`
- `task_memory_embeddings`
- `task_relations`

但检索仍偏分散：

- rule recall。
- recent recall。
- keyword recall。
- embedding full scan。
- task memory card text scoring。

需要一个统一入口。

### 8.2 新增 TaskSearchIndex

建议使用 SQLite FTS5，不急着引外部向量库。

```text
tasks
task_memory_cards
interactions
artifacts
        │
        ▼
task_search_index FTS5
        │
        ▼
candidate task ids
```

索引内容：

- task title。
- task goal。
- task summary。
- latest snapshot done / pending / nextStep / pauseReason。
- task memory card summary。
- key decisions。
- changed files。
- verification commands。
- pitfalls。
- artifacts paths。
- interaction user inputs。
- compact output summaries。

建议表：

```sql
CREATE VIRTUAL TABLE task_search_index USING fts5(
  task_id UNINDEXED,
  source_kind UNINDEXED,
  source_id UNINDEXED,
  title,
  body,
  tags,
  created_at UNINDEXED,
  updated_at UNINDEXED
);
```

注意：

- 不要把巨大 executor output 全量塞入 FTS。
- output 应先摘要或截断。
- 每条索引记录保留 provenance。

### 8.3 HybridTaskRetriever

召回流程：

```text
query
  │
  ├── explicit id / focus context
  │
  ├── FTS lexical search top 100-300
  │
  ├── task relation expansion
  │
  ├── status / recency / artifact / outcome scoring
  │
  ├── embedding rerank only on candidates
  │
  └── top K with reason + provenance
```

这比当前 embedding 全表扫描更稳。

输出：

```ts
type RetrievedTaskCandidate = {
  taskId: string;
  score: number;
  recallMode: "resume" | "reference" | "avoid" | "related";
  sources: Array<{
    kind: "focus" | "fts" | "semantic" | "relation" | "recent" | "explicit";
    sourceId: string;
    snippet: string;
  }>;
  artifacts: string[];
  pitfalls: string[];
  reason: string;
};
```

### 8.4 写入策略

索引应在这些时机更新：

- task created。
- task updated。
- snapshot appended。
- task done。
- task memory card generated。
- artifact added。
- interaction recorded。

第一版可以同步写入 SQLite。后续任务量更大时再做后台 rebuild。

## 9. 多执行器编排层

### 9.1 MultiExecutorOrchestrator 职责

职责：

- 接收 `ExecutionStrategy(mode=multi_executor)`。
- 按依赖执行 work units。
- 支持并行执行无依赖 work units。
- 保存每个 work unit 的 result。
- 失败时判断 retry / fallback / block。
- 把结果交给 Aggregator。

不负责：

- 判断是不是 task。
- 选择 conversation vs durable task。
- 做最终业务总结。
- 修改 task boundary。

### 9.2 执行模式

支持三种：

```text
sequential
  A -> B -> C

parallel
  A + B + C -> aggregation

dag
  A + B -> C -> D
```

第一版建议只做：

- sequential。
- parallel fan-out + aggregation。

DAG 可以等第二版。

### 9.3 结果模型

```ts
type WorkUnitResult = {
  workUnitId: string;
  executorName: string;
  status: "success" | "failed" | "timeout" | "cancelled";
  output: string;
  artifacts: string[];
  error?: string;
  startedAt: string;
  finishedAt: string;
};
```

## 10. Aggregator + Verification

Aggregator 是 MetaClaw 层能力，不是另一个 executor。

职责：

- 汇总 work unit 结果。
- 检查依赖结果是否缺失。
- 检查不同 executor 是否冲突。
- 检查 acceptance criteria 是否满足。
- 生成最终用户可读结果。
- 写入 task summary / artifacts / task memory card。

Verification 第一版规则化：

- patch 类 work unit 必须有测试命令或明确说明未跑测试。
- research 类 work unit 必须列出来源或说明来源限制。
- review 类 work unit 必须给出 pass / concerns。
- artifact 类 work unit 必须返回文件路径。

后续可以再让 `deepseek-tui` 或 `codex-cli` 做独立 review work unit，但 Aggregator 仍归 MetaClaw 控制。

## 11. 分阶段实施计划

### Phase A：Task Search Index

目标：建立任务检索索引，替代全量扫描作为主要候选来源。

工作：

- 新增 FTS5 表。
- 新增 `TaskSearchIndexRepo`。
- 新增 index writer。
- 在 task create/update/snapshot/card/interaction 写入时同步更新索引。
- 新增 rebuild 命令：`/task index rebuild`。

测试：

- task title / goal 可搜。
- snapshot 内容可搜。
- task memory card 可搜。
- artifact path 可搜。
- rebuild 后结果一致。

### Phase B：HybridTaskRetriever

目标：统一任务候选召回。

工作：

- 新增 `HybridTaskRetriever`。
- FTS 先召回候选。
- relation expansion。
- embedding 只对候选 rerank。
- 替换 `HybridMemoryRecaller` 中 task embedding full scan 的路径。
- 替换 intent reference 的 recent-only 候选。

测试：

- 明确 task id 优先。
- focus context 优先。
- FTS 命中历史任务。
- semantic rerank 只处理候选集。
- irrelevant / hide feedback 生效。

### Phase C：ExecutionStrategyPlanner

目标：判断 single executor vs multi executor。

工作：

- 新增窄模块 `ExecutionStrategyPlanner`。
- 输入复用 `ExecutionPlan`、`ExecutorRouteDecision`、retrieved tasks。
- 基于复杂任务信号输出 strategy。
- 默认 single executor。
- 只有强信号才 multi executor。

测试：

- 单一 bugfix -> single。
- 单一解释 -> single。
- 调研 + 实现 + review -> multi。
- repo mutation + high risk -> multi with review work unit。
- 用户显式要求多 agent -> multi。

### Phase D：MultiExecutorOrchestrator MVP

目标：执行 multi work units。

工作：

- 新增 work unit result 存储，可以先 JSON 放在 task artifacts/metadata，后续再建表。
- 支持 sequential。
- 支持 parallel fan-out + aggregation。
- 每个 work unit 走 existing `ExecutorRouter` 或 executor hint。
- 失败时 block 主 task，记录失败 work unit。

测试：

- sequential A -> B 成功。
- parallel A + B 成功。
- 一个 work unit 失败，主任务 blocked。
- codex fallback 不影响其他 work unit。

### Phase E：Aggregator + Verification

目标：让 MetaClaw 汇总多 executor 结果，而不是直接拼接。

工作：

- 新增 `ExecutionAggregator`。
- 定义 aggregation prompt / rules。
- 检查 acceptance criteria。
- 生成 final output。
- 更新 task summary / task memory card。

测试：

- research + implementation 输出被汇总。
- conflicting results 被标记。
- missing artifact 被标记 concern。
- 未跑测试被显式说明。

## 12. 不做事项

本轮明确不做：

- Executor Discovery。
- GatewayRuntime 收敛。
- 多客户端平台化。
- 远程 Registry。
- 插件市场。
- 局域网 executor 探测。
- 重写 `MetaclawSession`。
- 新增重复的 `TaskExplainer`。
- 把每个 work unit 都变成 durable task。
- 让动态权重覆盖 repo mutation hard rule。

## 13. 推荐落地顺序

```text
Phase A: Task Search Index
      │
      ▼
Phase B: HybridTaskRetriever
      │
      ▼
Phase C: ExecutionStrategyPlanner
      │
      ▼
Phase D: MultiExecutorOrchestrator MVP
      │
      ▼
Phase E: Aggregator + Verification
```

原因：

- 没有任务检索索引，多 executor 编排会缺上下文。
- 没有统一 retriever，TaskIntentResolver 会继续依赖 recent tasks。
- 没有 ExecutionStrategyPlanner，multi executor 会污染 ExecutorRouter。
- 没有 Aggregator，多 executor 只是并发执行，不是 MetaClaw 级编排。

## 14. Worktree 并行策略

可以并行：

| Lane | 工作 | 模块 |
|------|------|------|
| A | Task Search Index | `src/storage`, `src/core`, `tests/storage`, `tests/core` |
| B | Task Boundary Strategy Tests | `src/core/task-routing.ts`, `src/session/session-helpers.ts`, `tests/session`, `tests/tui` |
| C | ExecutionStrategyPlanner | `src/core`, `tests/core` |

不建议并行：

- MultiExecutorOrchestrator 和 Aggregator 最好等 StrategyPlanner 稳定后做。
- 不要同时大改 `MetaclawSession` 和 task index 写入链路。

## 15. 成功标准

本轮升级完成后，MetaClaw 应该能稳定回答：

1. 用户这句话为什么是 conversation / task_control / durable_task？
2. 当前任务最相关的历史任务是什么，为什么相关？
3. 召回结果来自哪里：FTS、semantic、relation、focus，还是 explicit id？
4. 当前任务为什么 single executor 就够，或为什么需要 multi executor？
5. 每个 work unit 谁负责，依赖什么，产出什么？
6. 最终汇总是否满足验收标准，有没有冲突、缺口或未验证项？

如果这些问题都有结构化答案，MetaClaw 才真正从“会管理任务的 agent”升级成“Task OS”。
