# DeepSeek Review：架构路线图完整对照报告

日期：2026-06-23
更新：2026-06-24，本轮按 TDD 完成阶段 8 facade 收敛补强。

## 结论

逐条对照 `docs/plans/2026-06-21-metaclaw-architecture-convergence-roadmap.md` 的全部设计要求。路线图中列出的全部优化点已实现：7 层架构全部在位，6 个原始问题全部解决，SchedulerBridge 连接正确，硬规则已降级为 hints/guards，Agentic Loop 已接入主路径，测试矩阵已落地。阶段 0-8 全部绿灯，`MetaclawSession` 已进一步收敛为 facade / coordinator。

## 一、核心问题解决对照（2.1-2.6）

| # | 原始问题 | 状态 | 证据 |
|---|---|---|---|
| 2.1 | MetaclawSession God Object | ✅ | 3897→2252 行；executor admin、profile persistence、routing coordinator、skill progress、workspace fs effects、session persistence、memory capture、presentation formatting 均已迁出 |
| 2.2 | 语义路由无单一事实源 | ✅ | IntentOrchestrator.decide() 是唯一 NL 入口，旧方法仅通过 adapter 边界调用 |
| 2.3 | 硬规则直接决定行为 | ✅ | 架构测试验证 session 不含 isConversationDerivedWorkInstruction(userInput) 等覆盖调用 |
| 2.4 | Agentic Loop 未接入 | ✅ | ExecutionRuntime.run() 调用 MultiExecutorOrchestrator + AgenticLoopController |
| 2.5 | Executor registry/factory 不统一 | ✅ | ExecutorRegistry 使用 adapterFactories dict；旧 factory.ts 已标记 @deprecated 且无外部引用 |
| 2.6 | Scheduler 归属不清 | ✅ | SchedulerEngine 实现 SchedulerBridge，连接 TaskRuntimeService 和 ExecutionRuntime |

## 二、7 层目标架构职责对照（3.1-3.8）

### 3.1 InputController ✅
- 文件：src/session/input-controller.ts（60 行）
- InputControllerPort 接口解耦 session，统一调度 slash command / pending confirmation / NL input
- 不做约束：grep 确认 0 个 executor router / memory context / execution runtime import

### 3.2 IntentOrchestrator ✅
- 文件：src/core/intent-orchestrator.ts（431 行）
- IntentDecisionV2 / IntentOrchestratorInput / RuleHint 全部按路线图 schema 定义
- IntentOrchestrator.createDefault() 内部装配 SemanticIntentRouter，session 不再直接 import
- 单次裁决超时 + conservative fallback

### 3.3 TaskRuntimeService ✅
- 文件：src/core/task-runtime-service.ts（502 行）
- TaskRuntimeCommand（14 种命令）、TaskRuntimeResult、SchedulableTask、SchedulerBridge 完整定义
- 全生命周期：create / bind / resume / fork / block / unblock / cancel / status / resume_parked
- 不做约束：不调用 LLM、不选 executor、不召回 memory

### 3.4 MemoryContextService ✅
- 文件：src/core/memory-context-service.ts（188 行）
- MemoryContextServiceInput / MemoryContextServiceResult 完整定义
- inline-resource-normalizer.ts 独立模块

### 3.5 ExecutionPlanningService ✅
- 文件：src/core/execution-planning-service.ts（233 行）
- ExecutionPlanV2 和 ExecutionResult 按路线图 schema 定义
- 基于 IntentDecisionV2.execution 决定 single/race/multi executor

### 3.6 ExecutionRuntime ✅
- 文件：src/core/execution-runtime.ts（421 行）
- ExecutorRegistry 注册表驱动（adapterFactories dict + custom profile）
- MultiExecutorOrchestrator + AgenticLoopController 接入主路径

### 3.7 VerificationAndDeliveryService ✅
- 文件：src/core/verification-and-delivery-service.ts（520 行）
- Verifier interface + 四个实现：HeuristicVerifier / AggregationVerifier / TestEvidenceVerifier / ArtifactVerifier

### 3.8 SchedulerBridge ✅
- 接口定义：task-runtime-service.ts lines 27-33，按路线图 schema
- 实现：SchedulerEngine 完整实现 5 个方法
- 边界规则：TaskRuntimeService 产生可调度状态，ExecutionRuntime 消费执行，Scheduler 协调

## 三、阶段 0-7 验收对照

| 阶段 | 状态 | 关键证据 |
|---|---|---|
| 0 止血和基线 | ✅ | /executor route 已修复（buildPreviewIntentDecision），重复 import 已清理 |
| 1 IntentOrchestrator | ✅ | 架构测试禁止 session 含 resolveRoute( / resolveIntent( 等 10 条规则 |
| 2 InputController | ✅ | InputController 不 import 越界模块（grep 0 匹配） |
| 3 TaskRuntimeService | ✅ | session 不含 taskRepo. 调用；scheduler.getNext() → taskRuntimeService |
| 4 硬规则降级 | ✅ | session 不含 parseTaskClearInstruction / isConversationDerivedWorkInstruction(userInput) |
| 5 ExecutionPlanningService | ✅ | ExecutionPlanV2 / ExecutionResult 定义为阶段 6/7 契约 |
| 6 ExecutionRuntime | ✅ | session 使用 scheduler.markDispatch*；不含直接 transitionTask 调用 |
| 7 VerificationAndDelivery | ✅ | session 委托 verificationAndDeliveryService.deliverTaskCompletion |

## 四、8 条成功标准对照

| # | 标准 | 状态 |
|---|---|---|
| 1 | 自然语言决策只有一个入口 | ✅ |
| 2 | 所有 NL 输入只产生一个 IntentDecisionV2 | ✅ |
| 3 | regex 不再直接决定业务行为 | ✅ |
| 4 | MetaclawSession 不再是中央大脑 | ✅ |
| 5 | 复杂任务经过 planner/orchestrator/agentic loop | ✅ |
| 6 | 验收和 delivery 统一出口 | ✅ |
| 7 | executor 新增路径 registry driven | ✅ |
| 8 | architecture tests 防止回退 | ✅ |

### 第 4 条完成说明
`MetaclawSession` 不再直接执行 interactions SQL、ExecutorRouteEventRepo、ExecutorProfileRepo、SkillUsageEventRepo、executor register wizard 状态机、GitHub runtime inference、workspace mkdir 或 executor routing display label 逻辑。

本轮新增抽取：

- `SessionPersistenceService`：interactions 与 route event 持久化。
- `ExecutorProfileService`：默认 profile seed 与 profile repo 访问。
- `ExecutorAdminService`：executor register wizard、项目 URL runtime inference、profile upsert。
- `ExecutorRoutingCoordinator`：执行器 profile 加载、ExecutionPlanningService 调用、route event 记录、路由展示文案。
- `ExecutionProgressService`：executor progress 去重、skill usage event 写入、verification evidence 收集。
- `WorkspaceTargetService`：workspace target 目录创建。

## 五、测试矩阵（5.1-5.3）✅

- Golden Intent Corpus：tests/core/intent-golden.test.ts（256 行）
- Architecture Boundary Tests：tests/session/metaclaw-session-architecture-boundary.test.ts（12 个约束规则）
- Service Extraction Tests：tests/core/session-extraction-services.test.ts、tests/core/executor-admin-and-routing-services.test.ts、tests/core/execution-progress-and-workspace-services.test.ts
- 覆盖：NL 入口统一、硬规则禁止、SchedulerBridge 使用、task parsing 迁出、delivery 委托、persistence 迁出、memory capture 迁出、presentation 迁出、executor admin / routing / progress / workspace effects 迁出

## 六、阶段 8 剩余 TODO

阶段 8 facade 收敛相关 TODO 已完成。

可选后续清理不再阻塞 `MetaclawSession` 架构目标：

1. 删除或迁移已标记 deprecated 的 `src/executor/factory.ts`，前提是确认外部插件/脚本没有引用。
2. 继续压缩 `MetaclawSession` 内的低风险协调代码，例如 idle guidance lifecycle 与 startup recovery lifecycle；这属于 facade 体积优化，不再是主路径架构缺口。
