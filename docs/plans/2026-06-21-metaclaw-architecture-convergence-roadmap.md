# MetaClaw 当前实现 Review 与架构收敛升级方案

日期：2026-06-21

## 1. 核心结论

本文基于当前代码实现 review 得出，目标是把 review 发现的问题转化为完整架构升级路线。它不是局部优化清单，而是从当前 session-centric 架构迁移到 7 层主路径架构的执行方案。

MetaClaw 当前不是方向错误，而是新架构层已经长出来，但旧的 `MetaclawSession` 中央大脑还没有退场。

当前最核心的问题不是继续横向增加能力，而是把自然语言决策入口、任务生命周期、上下文构建、执行规划、执行运行时、验收交付全部收敛到清晰边界。否则后续每加一个功能，都会继续增加硬规则、旁路模块和 session 耦合。

目标架构应完整收敛为 7 层：

```text
InputController
  -> IntentOrchestrator
  -> TaskRuntimeService
  -> MemoryContextService
  -> ExecutionPlanningService
  -> ExecutionRuntime
  -> VerificationAndDeliveryService
```

这不是要一次性重写系统，而是按目标架构逐层替换主路径。每拆出一层，它必须立即成为主路径的一部分，不能再新增“写好了但没被调用”的旁路模块。

调度器是 7 层之间的桥接协调器，不作为独立第 8 层。它位于 `TaskRuntimeService` 和 `ExecutionRuntime` 之间：

- `TaskRuntimeService` 负责判断任务是否可调度，输出可调度任务队列、阻塞原因和优先级。
- `ExecutionRuntime` 负责从队列消费任务、执行任务、回写运行结果。
- Scheduler 负责连接两者，维护 active dispatch、queued execution、schedule next、wait async work 等运行时协调状态。

## 2. 当前主要问题

### 2.1 `MetaclawSession` 已成为 God Object

`src/session/metaclaw-session.ts` 同时承担：

- 输入分流。
- pending 状态处理。
- 风险确认。
- 任务过滤。
- route / intent 决策。
- durable task 创建与绑定。
- 任务控制。
- 阻塞恢复。
- 记忆召回。
- 上下文构建。
- executor 路由。
- executor 竞速。
- fallback。
- 进度回调。
- artifact 捕获。
- Feishu 文档投递。
- 输出格式化。

典型问题集中在：

- `handleNaturalLanguageInput()`：自然语言输入、任务绑定、任务控制、风险门控和调度入口混在一起。
- `executeTask()`：记忆、上下文、executor、race、fallback、结果处理、delivery 全部混在一起。

这会导致任何新功能都倾向继续往 session 里塞判断，系统复杂度线性增长，回归风险持续上升。

### 2.2 语义路由没有单一事实源

当前存在多个并行入口：

- `llmBridge.resolveRoute()`
- `llmBridge.resolveIntent()`
- `llmBridge.resolveTaskStateOwnership()`
- `llmBridge.resolveIntentDecision()`
- `SemanticIntentRouter.decide()`
- `ExecutorRouter.route()`

它们分别输出不同 schema：

- `RouteResult`
- `IntentResult`
- `TaskStateOwnershipResult`
- `IntentDecision`
- `SemanticIntentDecision`
- `ExecutorRouteDecision`

这些入口没有统一裁决模型，也没有统一置信度、风险、任务绑定、executor 选择和澄清策略。更严重的是，`SemanticIntentRouter` 当前已经存在，但没有成为主路径入口。

### 2.3 硬规则仍在关键路径上直接决定行为

硬规则目前不只是 parser 或 safety guard，而是直接决定：

- 是否 task control。
- 是否 durable task。
- 是否状态查询。
- 是否清空任务。
- 是否继续旧任务。
- 是否 conversation continuation。
- 是否高风险外发。
- 是否复杂任务。

硬规则里有真实领域知识，不能直接删除。但它们不应该作为最终业务决策源，只能降级为 hints 或 guards。

### 2.4 Agentic Loop 和复杂执行链路没有接入主路径

`ExecutionStrategyPlanner`、`MultiExecutorOrchestrator`、`AgenticLoopController` 已经存在，但当前执行主路径仍然是：

```text
executeTask
  -> memory recall
  -> context bundle
  -> resolveExecutorForTask
  -> executeWithOptionalRace
  -> result handling
```

这意味着复杂任务规划、多 executor 编排和 agentic verification 还没有真正成为系统运行路径。

### 2.5 Executor registry 和 factory 仍未统一

当前 executor profile registry 负责描述能力和路由，但 adapter 创建仍由硬编码 factory 维护。新增 executor 仍需要同时修改 profile、factory、route、adapter、setup 等多个位置。

### 2.6 Scheduler 归属不清

当前 `SchedulerEngine`、`activeDispatches`、`queuedExecution`、`submitScheduledTask()`、`scheduleNext()` 和 `waitForAsyncWork()` 分散在 `MetaclawSession` 主类中。调度器既不是纯任务生命周期，也不是纯 executor runtime。

如果架构升级不定义调度器归属，拆到阶段 3 和阶段 6 时会出现新的边界债务：任务服务不知道谁负责取下一个任务，执行运行时不知道谁负责排队和恢复。

本方案将 Scheduler 定义为 `TaskRuntimeService` 和 `ExecutionRuntime` 之间的协调契约，而不是某一层内部的私有细节。

## 3. 目标架构职责

### 3.1 InputController

职责：

- 接收 TUI / script / gateway 输入。
- 归一化输入事件。
- 处理 slash command。
- 处理 pending confirmation 状态。
- 把自然语言输入交给 `IntentOrchestrator`。

不做：

- 不判断 durable task。
- 不选 executor。
- 不恢复任务。
- 不构建上下文。
- 不执行任务。

### 3.2 IntentOrchestrator

职责：

- 唯一自然语言裁决入口。
- 统一 route、intent、task ownership、task control、executor dispatch、risk、clarification。
- 输出 `IntentDecisionV2`。
- 消费 rule hints，但不让 rule hints 单独决定业务行为。

不做：

- 不创建任务。
- 不执行任务。
- 不直接操作 task repo。
- 不创建 executor adapter。

### 3.3 TaskRuntimeService

职责：

- create / bind / resume / fork / block / unblock / cancel / status。
- 根据 `IntentDecisionV2.task` 执行任务生命周期动作。
- 维护 current task、focus task、last task。
- 处理 parked resume、blocked resume、done follow-up。
- 计算可调度任务队列。
- 输出任务调度资格、阻塞原因和优先级。

不做：

- 不调用 LLM。
- 不选 executor。
- 不召回 memory。
- 不格式化 UI 文案。
- 不直接消费队列执行 executor。

### 3.4 MemoryContextService

职责：

- memory recall。
- preference recall。
- task retrieval。
- conversation recall。
- resume context bundle。
- inline resource 归一化。
- 输出统一 `ExecutionContext`。

不做：

- 不决定是否创建任务。
- 不选 executor。
- 不执行任务。
- 不做最终验收。

### 3.5 ExecutionPlanningService

职责：

- 基于 `IntentDecisionV2.execution` 决定 single executor、race executor、multi executor。
- 选择 executor profile。
- 生成 work units。
- 生成 acceptance criteria。
- 输出 `ExecutionPlanV2`。

不做：

- 不创建 adapter。
- 不跑 executor。
- 不投递 artifact。

### 3.6 ExecutionRuntime

职责：

- 创建 executor adapter。
- 从 Scheduler 提供的可执行任务中消费执行请求。
- 执行 single executor。
- 执行 race executor。
- 执行 multi executor orchestration。
- 处理 abort / timeout / fallback。
- 处理 progress event。
- 将 recoverable failure 转为 task block。
- 向 Scheduler 回写完成、失败、阻塞和可继续调度信号。

不做：

- 不判断用户意图。
- 不做 memory recall。
- 不格式化最终展示。
- 不做最终验收裁决。

### 3.7 VerificationAndDeliveryService

职责：

- verifier pipeline。
- result aggregation。
- test evidence verification。
- artifact extraction。
- Feishu / preview / notification delivery。
- final output formatting。
- task completion summary。

不做：

- 不选 executor。
- 不恢复任务。
- 不决定自然语言 intent。

### 3.8 Scheduler Bridge

Scheduler 不是独立业务层，而是 `TaskRuntimeService` 和 `ExecutionRuntime` 之间的运行时桥接接口。

建议接口：

```ts
interface SchedulableTask {
  taskId: string;
  priority: 'normal' | 'high' | 'urgent';
  reason: string;
  executionRequest: QueuedExecutionRequest;
}

interface SchedulerBridge {
  getNext(): Promise<SchedulableTask | null>;
  markDispatchStarted(taskId: string, executionId: string): void;
  markDispatchFinished(taskId: string, result: ExecutionResult): Promise<void>;
  markDispatchBlocked(taskId: string, reason: string): Promise<void>;
  waitForIdle(): Promise<void>;
}
```

`markDispatchStarted()` 只更新内存态 active dispatch，可以同步完成；`markDispatchFinished()` 和 `markDispatchBlocked()` 需要持久化任务状态、写入结果并触发后续调度，所以返回 `Promise<void>`。

边界规则：

- `TaskRuntimeService` 只负责产生和更新可调度状态。
- `ExecutionRuntime` 只负责消费和执行。
- Scheduler bridge 负责 active dispatch、queued execution、schedule next 和 wait async work。

## 4. 分阶段行动路线

### 阶段 0：止血和基线

目标：恢复当前代码健康，冻结重构前行为基线。

行动：

- 删除重复 `SemanticIntentRouter` import。
- 处理 `LlmBridge.resolveIntentDecision()` 当前类型错误：阶段 0 不把它作为新主路径修复，只标记为 legacy / deprecated，并保证它不阻塞 `npm run lint`。
- 修复 `/executor route` 对 `ExecutorRouter.route()` 的错误调用：命令必须先构造 `IntentDecision`，再传入 `ExecutorRouter.route({ decision, defaultExecutorName })`。
- 跑通 `npm run lint`。
- 建立当前 session 行为 smoke tests。
- 新增架构目标文档和禁止跨层调用原则。

验收：

- `npm run lint` 通过。
- 现有核心 session 测试不回退。
- 当前自然语言任务创建、恢复、清空、阻塞恢复、执行、artifact 输出有 smoke 覆盖。

### 阶段 1：IntentOrchestrator 成为唯一自然语言入口

目标：收敛所有自然语言决策。

行动：

- 定义 `IntentDecisionV2`。
- 定义 `IntentOrchestratorInput` 和 `RuleHint`。
- 新建 `IntentOrchestrator.decide(input)`。
- 阶段 1 就提供最小化 `RuleHintsProvider`，先把现有自然语言 regex 包装为 hints，不等待阶段 4。
- 收编以下入口：
  - `resolveRoute`
  - `resolveIntent`
  - `resolveTaskStateOwnership`
  - `resolveIntentDecision`
  - `SemanticIntentRouter.decide`
  - executor dispatch 相关自然语言裁决
- `SemanticIntentRouter` 改为 `IntentOrchestrator` 内部 LLM adapter。
- `MetaclawSession.handleNaturalLanguageInput()` 只允许调用 `IntentOrchestrator.decide()`。
- 旧入口标记为 legacy。
- 增加 architecture test，禁止自然语言主路径直接调用旧 route / intent 方法。
- 设置单次裁决 timeout，超时后返回 conservative decision：普通对话或 clarification，不允许 fallback 关键词直接创建任务。

`IntentOrchestratorInput` 至少包含：

```ts
interface IntentOrchestratorInput {
  userInput: string;
  recentTasks: TaskSummary[];
  executorProfiles: ExecutorProfile[];
  defaultExecutorName: string;
  currentFocus: {
    kind: 'conversation' | 'task';
    taskId: string | null;
  } | null;
  hints: RuleHint[];
  allowDurableTask: boolean;
  allowFileModification: boolean;
  timeoutMs: number;
}
```

`RuleHint` 至少包含：

```ts
interface RuleHint {
  source: 'parser' | 'safety_guard' | 'heuristic';
  kind:
    | 'task_control'
    | 'durable_work'
    | 'status_query'
    | 'clear_tasks'
    | 'resume_task'
    | 'conversation_continuation'
    | 'risk_external_send'
    | 'priority'
    | 'resource_reference';
  weight: number;
  reason: string;
  evidence: string;
}
```

`IntentDecisionV2` 至少包含：

```ts
interface IntentDecisionV2 {
  interactionType:
    | 'direct_reply'
    | 'task_control'
    | 'durable_task'
    | 'executor_dispatch'
    | 'clarification';
  confidence: number;
  reason: string;
  clarificationQuestion: string | null;
  risk: {
    level: 'low' | 'medium' | 'high';
    requiresConfirmation: boolean;
    reasons: string[];
  };
  task: {
    binding: 'new' | 'reference' | 'none';
    taskId: string | null;
    control:
      | 'clear_tasks'
      | 'status_query'
      | 'resume_task'
      | 'recover_blocked'
      | 'last_task_continuation'
      | 'none';
    scope: string | null;
  };
  execution: {
    mode: 'none' | 'single_executor' | 'race_executors' | 'multi_executor';
    complexity: 'simple' | 'moderate' | 'complex';
    selectedExecutor: string | null;
    candidateExecutors: string[];
    requiresVerification: boolean;
    canModifyFiles: boolean;
    requiresExternalGateway: boolean;
  };
  hints: RuleHint[];
}
```

验收：

- 自然语言输入只产生一个 `IntentDecisionV2`。
- session 主路径不再直接调用 `resolveRoute()` / `resolveIntent()` / `resolveTaskStateOwnership()`。
- golden intent corpus 覆盖 conversation、task control、durable task、executor dispatch、blocked resume、status query、follow-up、external risk。
- pending confirmation 的完整迁出依赖阶段 2；阶段 1 只要求 pending 流程进入自然语言裁决前不再额外调用旧 route / intent 方法。

### 阶段 2：InputController

目标：把输入边界从 session 中拆出。

行动：

- 新增 `src/session/input-controller.ts`。
- `MetaclawSession.submit()` 退化为 thin facade。
- `InputController` 统一调度 slash command、pending confirmation 和 natural language input。
- `CommandRouter` 继续负责 slash command 解析，但由 `InputController` 统一调用。

验收：

- slash command、普通聊天、任务输入、pending 风险确认行为保持一致。
- `InputController` 不 import executor router、memory context、execution runtime。

### 阶段 3：TaskRuntimeService

目标：任务生命周期从 session 中移出。

行动：

- 新增 `src/core/task-runtime-service.ts`。
- 定义 `TaskRuntimeCommand`。
- 定义 `TaskRuntimeResult`。
- 迁移 create、bind、resume、fork、block、unblock、cancel、status。
- 迁移 parked resume、blocked resume、done follow-up。
- 迁移 current task、focus task、last task 管理。
- 定义 `SchedulableTask` 和 `SchedulerBridge` 的任务侧契约。
- 把可调度性判断、阻塞判断、优先级判断从 session 中迁出。

验收：

- 任务控制相关测试通过。
- `MetaclawSession` 不再直接散落大量 `taskRepo.findById()`、`taskRepo.update()`、`taskEngine.transition()` 调用。
- `TaskRuntimeService` 不调用 LLM、不选 executor。
- `SchedulerEngine` 可以通过 `TaskRuntimeService` 获取下一个可调度任务，而不是直接依赖 session 私有状态。

### 阶段 4：MemoryContextService

目标：上下文构建从执行方法中拆出。

行动：

- 新增 `src/core/memory-context-service.ts`。
- 定义 `ExecutionContextBundleV2`。
- 迁移 memory recall、preference recall、conversation recall、resume context bundle。
- 迁移 inline resource 归一化。
- 完善阶段 1 的最小化 `RuleHintsProvider`。
- 将 `task-routing.ts` 和 `session-helpers.ts` 中自然语言 regex 降级为 hints 或 guards。

硬规则分类：

- Parser rules：只解析明确命令，例如 `/task index rebuild`、`/executor list`。
- Safety guards：只做保守拦截，例如危险删除、生产环境、外部发送。
- Hints：只作为语义模型辅助信号，不能单独决定 durable task、executor、multi-agent、恢复任务。

验收：

- `executeTask()` 中记忆召回和上下文构建逻辑迁出。
- regex 不再直接创建、恢复、清空自然语言任务。
- safety guard 仍能阻止或要求确认高风险动作。

### 阶段 5：ExecutionPlanningService

目标：执行策略成为主路径，而不是旁路模块。

行动：

- 新增 `src/core/execution-planning-service.ts`。
- 定义 `ExecutionPlanV2`。
- 定义 `ExecutionResult` 草案，作为阶段 6 runtime 和阶段 7 delivery 的契约。
- `ExecutionStrategyPlanner` 改为内部 planner。
- planner 入口改为 `IntentDecisionV2.execution`。
- 关键词复杂度判断只保留为 fallback hints。
- 生成 single executor、race executor、multi executor plan。
- 生成 work units 和 acceptance criteria。

`ExecutionResult` 至少包含：

```ts
interface ExecutionResult {
  taskId: string;
  executionId: string;
  status: 'success' | 'failed' | 'blocked' | 'cancelled';
  executorName: string;
  output: string;
  error: string | null;
  artifacts: string[];
  workUnitResults: WorkUnitResult[];
  durationMs: number;
  userPrompt: string;
  preferences: ResolvedPreference[];
  context: ExecutionContextBundleV2;
  recovery: {
    recoverable: boolean;
    blockReason: string | null;
  };
}
```

验收：

- 简单任务走 single executor。
- 明确竞速任务走 race executors。
- 复杂任务进入 multi executor。
- 是否 multi executor 不再主要由关键词触发，而由 `IntentDecisionV2.execution.complexity` 触发。

### 阶段 6：ExecutionRuntime

目标：实际执行从 session 中移出。

行动：

- 新增 `src/core/execution-runtime.ts`。
- 新增 `ExecutorRegistry`。
- 内置 executor 也改为 `profile + adapterFactory` 注册。
- `CustomCliExecutorAdapter` 作为统一 runtime command adapter 基础。
- `QueuedExecutionRequest.semanticExecutorDecision` 必须贯穿到 runtime，不允许执行时重新做自然语言路由。
- `MultiExecutorOrchestrator` 接入主路径。
- `AgenticLoopController` 接入复杂任务主路径。
- 后序 work unit 必须能看到前序 work unit 输出。
- `ExecutionRuntime.run()` 只产出标准化 `ExecutionResult`，不内联 Feishu 投递和最终展示。
- Scheduler bridge 接入 runtime：执行完成后通过 `markDispatchFinished()` 或 `markDispatchBlocked()` 触发后续调度。

验收：

- `executeTask()` 退化为调用 `ExecutionRuntime.run(plan, context)`。
- 复杂任务实际经过 planner、orchestrator、agentic loop。
- executor 创建不再依赖多处硬编码 if-else。
- 新增 executor 只需要注册 profile 和 adapter factory。
- Feishu delivery 在阶段 6 暂由兼容层消费 `ExecutionResult` 继续保持行为，阶段 7 再正式迁入 `VerificationAndDeliveryService`。

### 阶段 7：VerificationAndDeliveryService

目标：验收、总结、artifact、通知统一出口。

行动：

- 新增 `src/core/verification-and-delivery-service.ts`。
- 定义 `Verifier` interface。
- 当前 regex 验收改为 `HeuristicVerifier`。
- 增加：
  - `LlmVerifier`
  - `TestEvidenceVerifier`
  - `ArtifactVerifier`
- `ExecutionAggregator` 降为 verifier pipeline 的 helper 或一个实现。
- 迁移 artifact extraction。
- 迁移 Feishu document artifact。
- 迁移 notification delivery。
- 迁移 final output formatting。
- 迁移 task completion summary。
- 接管阶段 6 兼容层里的 Feishu delivery。

验收：

- 执行结果必须通过统一 delivery 出口。
- regex verifier 只作为 smoke check，不作为唯一严肃验收层。
- task summary、artifact、notification 行为保持兼容。

### 阶段 8：收尾清理和强约束

目标：移除旧路径，防止架构回退。

行动：

- 删除或隔离 legacy route / intent 主路径。
- 删除 session 中的 executor routing、artifact extraction、Feishu artifact、task status formatting。
- `MetaclawSession` 只保留依赖装配、状态快照、事件输出 facade。
- 增加 architecture boundary tests：
  - session 不能 import `ExecutorRouter`。
  - session 不能 import 自然语言 task-routing parser。
  - session 不能直接 new executor adapter。
  - natural language path 只能调用 `IntentOrchestrator`。
  - execution path 只能通过 `ExecutionRuntime`。

验收：

- `MetaclawSession` 从大型中央类降为 facade / compat glue。
- 新功能必须挂到对应层，不允许继续往 session 塞主逻辑。

## 5. 测试路线

### 5.1 Golden Intent Corpus

新增 `tests/core/intent-golden.test.ts`，覆盖 100-200 条中英文真实输入：

- conversation。
- task_control。
- durable_task。
- executor_dispatch。
- blocked resume。
- parked resume。
- status query。
- follow-up。
- external risk。
- file mutation。
- research。
- multi executor。
- clarification。

每条样例固定预期：

- interaction type。
- task binding。
- task control kind。
- execution mode。
- risk level。
- requires confirmation。

执行方式：

- CI 默认使用 mock LLM 和固定 snapshot，验证 schema、归一化、fallback 和 regression。
- 首次建立语料和发布前可运行真实 LLM 评估，生成或更新 snapshot。
- 真实 LLM 结果不作为每次 CI 的硬依赖，避免网络、模型漂移和成本导致测试不稳定。

### 5.2 主路径约束测试

新增 architecture tests：

- session 主路径只能调用 `IntentOrchestrator.decide()`。
- session 不直接调用 legacy `resolveRoute()` / `resolveIntent()`。
- execution runtime 不调用 LLM intent method。
- verifier 不创建 executor。
- task runtime 不召回 memory。

实现方式：

- 短期用依赖注入和接口隔离：`MetaclawSession` 只接收 `IntentOrchestrator` 接口，不再直接接收或调用 legacy LLM route / intent 方法。
- 增加静态 import 扫描测试，禁止指定层 import 禁用模块。
- 后续可引入 `eslint-plugin-boundaries` 或 `no-restricted-imports`，把边界规则前移到 lint。

### 5.3 分层测试矩阵

```text
阶段 0：现有 smoke + lint
阶段 1：golden intent corpus
阶段 2：input controller tests
阶段 3：task runtime lifecycle tests
阶段 4：memory context bundle tests
阶段 5：execution planning matrix tests
阶段 6：execution runtime fake executor tests
阶段 7：verification/delivery tests
阶段 8：architecture boundary tests
```

## 6. 最终迁移顺序

1. 修复编译和基线。
2. 落地 `IntentDecisionV2` 和 `IntentOrchestrator`。
3. 让自然语言主路径只消费统一 decision。
4. 拆 `InputController`。
5. 拆 `TaskRuntimeService`。
6. 拆 `MemoryContextService`。
7. 接 `ExecutionPlanningService`。
8. 接 `ExecutionRuntime`。
9. 接 `VerificationAndDeliveryService`。
10. 删除旧旁路。
11. 增加架构边界测试。

## 7. 回滚策略

每个阶段都必须以可运行状态结束，并保留一个阶段的回滚窗口。

执行规则：

- 每个阶段完成后打 tag：`architecture-phase-0` 到 `architecture-phase-8`。
- 旧方法先标记 `@deprecated`，至少保留一个阶段，通过转发到新层维持兼容。
- 不在同一阶段同时迁移接口、删除旧路径和改测试基线。
- 阶段验收失败时，回滚到上一阶段 tag，而不是在半迁移状态继续堆补丁。
- 阶段 8 才删除 legacy 主路径和兼容 glue。

## 8. 成功标准

架构收敛完成后，应满足：

- 自然语言决策只有一个入口：`IntentOrchestrator.decide()`。
- 所有自然语言输入只产生一个 `IntentDecisionV2`。
- regex 不再直接决定 durable task、executor、multi executor、恢复任务。
- `MetaclawSession` 不再是中央大脑。
- 复杂任务真实经过 planner、multi executor orchestrator、agentic loop。
- 验收和 delivery 统一出口。
- executor 新增路径是 registry driven。
- architecture tests 能防止未来重新把逻辑塞回 session。

最终目标不是“多几个模块”，而是主路径真正变成：

```text
InputController
  -> IntentOrchestrator
  -> TaskRuntimeService
  -> MemoryContextService
  -> ExecutionPlanningService
  -> ExecutionRuntime
  -> VerificationAndDeliveryService
```

如果某个新模块没有进入这条主路径，它就不是架构升级，只是新的旁路代码。
