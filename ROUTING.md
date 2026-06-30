# MetaClaw 智能路由层 · 设计总览

> 本文档是路由层重构的整体思路总结,便于阅读与展示。细粒度决策记录见 [`docs/adr/`](docs/adr/),术语定义见 [`CONTEXT.md`](CONTEXT.md),分阶段实现计划见 [`docs/plans/2026-06-25-routing-layer-rewrite.md`](docs/plans/2026-06-25-routing-layer-rewrite.md)。

---

## 一句话定位

用 **LLM 分类 + 三指标选优 + fallback 兜底 + worktree 隔离** 的策略路由,取代当前 **静态 affinity 打分 + race 抢答** 的旧路由,在省 token 的前提下选出更可靠的结果。

---

## 1. 为什么要推翻现有路由

当前路由有三个硬伤,且互相放大:

| 问题 | 代码事实 | 后果 |
|---|---|---|
| **质量信号是死的** | `historicalSuccess` 启动时填死值(codex 0.85、pi 0.78…),全仓无回写路径 | "历史成功率"从不反映真实表现,打分权重仅 0.07,形同虚设 |
| **race 选速度不选质量** | `executeWithOptionalRace` 首个 `.then` settle 即胜出,abort 其余([execution-runtime.ts:355](src/core/execution-runtime.ts#L355)) | 慢的 agent 产出被丢弃,连评分机会都没有;被 abort 的 token 全浪费 |
| **race 是硬编码双 agent** | `resolveRuntimeExecutors` 只 filter `pi-agent \|\| hermes-agent`([execution-runtime.ts:307](src/core/execution-runtime.ts#L307)) | 根本不是通用并行,只是研究类双 agent 抢答 |

**结论**:race 既费 token,又选不出质量更高的 agent。推翻评估模型(race + affinity 打分)有充分代码依据。

---

## 2. 决策层的职责边界

MetaClaw 作为决策层,**只做协调,不做具体操作**:

```
决策层(MetaClaw)负责          执行器(executor)负责
─────────────────────         ─────────────────────
· 面向用户交流                · 实际代码修改 / git 落库
· 闲聊独立完成                · 工具调用 / 文件产出
· 任务分配决策(智能路由)      · 自测、返回结果
· 流程控制(进度/失败/重试)    · 上报执行结果
· 结果层日志(MCP失败/超时)
· 结果汇总与交付
```

边界铁律:**git 落库、实际更改等具体操作是执行器的事,决策层绝不碰。**

---

## 3. 核心概念

| 术语 | 含义 |
|---|---|
| **Work Unit** | 路由的输入单位——一个已拆解、目标明确的工作单元。路由**不拆解**,只接收并派发。 |
| **Capability Class** | 按**工具/副作用边界**的能力分类(非执行器强项)。7 个值:`code_edit \| research \| messaging \| memory_ops \| office_automation \| conversation \| general` |
| **Complementary Executor** | 互补执行器——每个能力类选一个,异类组合(一个编码 agent + 一个自动化 agent),而非同类冗余竞赛 |
| **Parallelism Criterion** | 串并行由**因果性**决定:无因果→并行(各占 worktree),有因果→跨 work unit 串行 |
| **Selection Signal** | 同类多 executor 选 primary 的三个硬指标:最近3任务成功率、待处理负载、价格 |
| **Fallback Chain** | primary 失败后,按三指标排序的同类候选,sequential 试下一个 |
| **ExecutionPolicy** | 路由产出物,取代旧 `ExecutionPlanV2`。不只描述"派给谁",还含隔离/验证/风险/降级 |

---

## 4. 路由数据流

```
用户输入
   │
   ▼
[拆解 skill —— 待建,本方案不涉及]
   │  产出 Work Unit(今天:flat Task 暂代)
   ▼
┌─────────────────────────────────────────────┐
│ 1. LLM 分类器(复用现有 semantic bridge)     │
│    Work Unit → CapabilityClass               │
│    (输出形态待定,暂按单类)                  │
├─────────────────────────────────────────────┤
│ 2. 候选筛选                                   │
│    能力表(注册制)→ 该类的可用 executors      │
│    × 可用性 × 订阅约束                        │
├─────────────────────────────────────────────┤
│ 3. 选 primary(同类多候选时)                 │
│    工具层提供三信号 → LLM 决定               │
│    其余同类候选 → 排序成 fallbackChain        │
├─────────────────────────────────────────────┤
│ 4. 装配 ExecutionPolicy                       │
│    isolationRequired / riskLevel /            │
│    verificationLevel / fallbackChain ...      │
└─────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────┐
│ 执行(runtime)                                │
│ · 无因果并行 → 各占独立 git worktree         │
│ · 有因果 → 跨 work unit 串行                 │
│ · primary 失败 → 判断层 → 试 chain 或上报用户│
│ · 验证 → 自验证(测试证据);review 待建       │
└─────────────────────────────────────────────┘
   │
   ▼
结果汇总 → 交付(CLI/TUI/飞书)
   │
   ▼
回写 executor_route_events.result(喂给下一次的三信号)
```

---

## 5. 关键决策一览

| # | 决策 | 要点 | ADR |
|---|---|---|---|
| 1 | 推翻范围 C2 + 删 race | 重写决策器与 plan 形状,runtime 单/多机制保留 | [0001](docs/adr/0001-abolish-race-and-rewrite-routing-as-policy.md) |
| 2 | CapabilityClass 取代 TaskRouteIntent | 无 shim,旧类型无生产者后删 | [0002](docs/adr/0002-capability-class-supersedes-task-route-intent.md) |
| 3 | 路由消费 work unit,不拆解 | 拆解是独立 skill,路由不背理解复杂度 | [0003](docs/adr/0003-router-consumes-work-units-not-raw-input.md) |
| 4 | worktree 隔离 + 因果判据 | 同 worktree 串行;并行=多 worktree;三范式范围;#69994 验证教训 | [0004](docs/adr/0004-parallel-isolation-via-worktree.md) |
| 5 | 三指标选 primary,LLM 决定 | 成功率/负载/价格;工具层只提供,LLM 权衡 | [0005](docs/adr/0005-selection-strategy-three-signals.md) |
| 6 | fallback chain + 可替换判断层 | 同类排序;失败先判性质(不可抗力→上报,能力不足→试下一个) | [0006](docs/adr/0006-fallback-chain-with-replaceable-failure-judgment.md) |
| 7 | verification/reviewer 挂起 | 代码类用三指标选 reviewer(不固定);其余风险交用户 | [0007](docs/adr/0007-verification-reviewer-mechanism-deferred.md) |
| 8 | CapabilityClass 7 个值 | 按工具/副作用边界;排除 reasoning(模型能力) | [0008](docs/adr/0008-capability-class-values.md) |
| 9 | 能力表注册制 | 不扫描;新增 MCP 经 6 步流程注册;未注册=不可用 | [0009](docs/adr/0009-capability-registry-registration-not-scan.md) |
| 10 | 分类用 LLM | 复用现有 semantic bridge;正则只留失败分类 | [0010](docs/adr/0010-classification-via-llm-reusing-existing-bridge.md) |

---

## 6. 三个设计原则

贯穿全部决策的三条主线:

1. **职责分层,边界清晰**。LLM 干它擅长的(理解任务、分类),工具层干它擅长的(提供硬指标),执行器干它擅长的(实际操作)。决策层不碰具体操作,不背质量预判(质量靠验证+fallback,不靠 affinity 打分)。

2. **能用规则确定的,不走 LLM**。意图分类靠 LLM(自然语言,规则覆盖不全);但失败分类、风险触发靠规则/hook(结构化、可确定)。LLM 不判风险——这是本次修正的关键认知。

3. **省 token 是硬约束**。删 race(不并行烧)、fallback 是 sequential(前一个明确失败才试下一个)、分类搭现有 LLM 调用的车(不新增预算)、review 只在值得时触发。每一处都对着"不浪费"这条线。

---

## 7. 与现有代码的接缝

改造集中在一条链路,**不外溢到 session/storage/gateway**:

```
semantic-intent-router.ts  ──改──►  产出 CapabilityClass(取代 TaskRouteIntent)
         │
execution-planning-service.ts ──改──►  调 ExecutionPolicyPlanner,产出 ExecutionPolicy
         │                        (新增 execution-policy-planner.ts)
         │
execution-runtime.ts ──改──►  删 race 分支,读 fallbackChain
         │
session-execution-coordinator.ts ──改──►  删 race 展示,接失败判断层
executor-routing-coordinator.ts ──改──►  删 race 文案
```

**新增**: `capability-class.ts`、`execution-policy.ts`、`execution-policy-planner.ts`、`executor-selection-signal-service.ts`
**删除**: race 相关分支、`TaskRouteIntent`、`DEFAULT_INTENT_AFFINITY`、`historicalSuccess`、`ExecutionPlanV2`(收尾阶段)

---

## 8. 待解决部分(本方案显式跳过)

这些是路由层最复杂、依赖前置设计的部分,本轮不钉,留待后续:

- **分解-DAG**:异步依赖(B 等 A)、多任务优先级、协调范式——整个路由层最复杂部分
- **分类器输出形态**:单类 / 主+辅 / 多类并行——依赖分解结构
- **能力表"调用方法"粒度**:工具级 schema vs 能力级摘要——由执行器自决
- **Reviewer + 高风险 hook**:需新建 hook 机制;`TaskStatus` 缺 `pending_review` 状态需补
- **价格数据**:信号3 无存储,需新建字段
- **失败判断 skill**:初版用现有正则,将来替换为 skill
- **拆解 skill**:任务分解的引导逻辑
- **能力表注册流程落地**:新增 MCP 的 6 步注册流程

每项在对应 ADR 的 Consequences/Gaps 里有详细记录,不会遗失。

---

## 附:产出物索引

| 文档 | 用途 |
|---|---|
| `CONTEXT.md` | 路由术语表(8 个核心概念) |
| `docs/adr/0001`–`0010` | 10 条决策的细粒度记录(含被拒方案、后果) |
| `docs/plans/2026-06-25-routing-layer-rewrite.md` | 分 6 阶段的实现计划 |
| `ROUTING.md`(本文档) | 整体思路,便于阅读与展示 |
