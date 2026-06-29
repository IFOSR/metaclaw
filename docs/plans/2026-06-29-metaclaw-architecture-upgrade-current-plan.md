# MetaClaw 当前架构升级方案

日期：2026-06-29

## 1. 背景

`docs/plans/2026-06-21-metaclaw-architecture-convergence-roadmap.md` 仍然是 MetaClaw 架构收敛的总路线。那份 roadmap 的核心判断是正确的：系统要从 session-centric 结构收敛到清晰的主路径，让自然语言裁决、任务生命周期、上下文构建、执行规划、执行运行时、验收交付分别位于明确的 module seam 后面。

截至当前实现，`2026-06-21` roadmap 中的大量主路径收敛已经完成：`InputController`、`IntentOrchestrator`、`TaskRuntimeService`、`MemoryContextService`、`ExecutionPlanningService`、`ExecutionRuntime`、`VerificationAndDeliveryService`、`SessionExecutionCoordinator` 都已经进入主路径。`MetaclawSession` 的 God Object 问题已经明显缓解。

新的主要问题从 `MetaclawSession` 转移到了 `src/core`。许多职责虽然已经从 session 中迁出，但仍混在 `core` 目录内：intent、routing、execution runtime、task runtime、memory、delivery、types 等都在同一个大包里。当前架构升级的重点因此进入第二阶段：不再只是收缩 `MetaclawSession`，而是收缩 `src/core`，并修正 routing/runtime seam。

`docs/plans/2026-06-24-metaclaw-roadmap-remaining-todos.md` 暂时不作为新的待办清单推进。当前方案只吸收其中已经完成的事实，不重新打开那份文档里的 remaining todos。

## 2. 和 2026-06-21 Roadmap 的关系

当前方案保留 `2026-06-21` roadmap 的 7 层主路径：

```text
InputController
  -> IntentOrchestrator
  -> TaskRuntimeService
  -> MemoryContextService
  -> ExecutionPlanningService
  -> ExecutionRuntime
  -> VerificationAndDeliveryService
```

但 `ExecutionPlanningService` / routing / runtime 这一段已经被后续 routing policy 改造覆盖。旧 roadmap 中关于 `ExecutionPlanV2` 和 `race_executors` 的描述不再作为目标架构执行。

当前替换关系：

- `ExecutionPlanV2` -> `ExecutionPolicy`
- `race_executors` -> sequential fallback policy
- static affinity / `TaskRouteIntent` -> `CapabilityClass + selection signals`
- hardcoded fallback -> `fallbackChain + failure judgment seam`

这意味着 `2026-06-21` 是总架构北极星，当前 routing/runtime policy 方案是对其中执行规划层的更新。不能为了对齐旧 roadmap 而恢复 `ExecutionPlanV2` 或 `race_executors`。

## 3. 当前目标架构

目标不是先做大规模目录搬家，而是让每个 module 拥有小 interface 和深 implementation。目录拆分应服务于 seam，而不是把现有复杂度机械移动到新文件夹。

建议最终包结构：

```text
src/routing/
src/execution/
src/task/
src/memory/
src/intent/
src/delivery/
src/executor/
src/storage/
src/session/
```

职责方向：

- `src/routing/`：`CapabilityClass`、`ExecutionPolicy`、policy planning、strategy planning、selection signals、route event projection。
- `src/execution/`：runtime、executor registry、fallback/failure judgment、progress、multi-executor orchestration、agentic loop。
- `src/task/`：task model、task lifecycle、task execution planning、scheduling eligibility。
- `src/memory/`：memory engine、recall、execution context bundle、recall review、memory capture。
- `src/intent/`：natural-language decision、semantic routing adapter、rule hints、intent schemas。
- `src/delivery/`：verification pipeline、artifact extraction、final formatting、notification delivery。
- `src/executor/`：concrete executor adapters and executor prompt/runtime adapter utilities。
- `src/session/`：composition/state/output facade and user interaction coordination。

`src/core` 应逐步退化为 compatibility/re-export 层，或被上述领域包替代。

## 4. 当前优先级

Priority 1：清理 routing seam。

让 `ExecutionStrategyPlanner` 不再依赖 `ExecutorRouteDecision`。strategy planning 的输入应围绕 policy 语义，而不是 legacy route event 形状：`capabilityClass`、`primaryExecutor`、`candidateExecutors`、`riskLevel`、`matchedBoundary`、`resources`、`recalledTaskIds`、`taskExecutionPlan`。`ExecutorRouteDecision` 只应保留为 route event persistence/display 的 projection，不进入 runtime planning。

Priority 2：补 `ExecutorSelectionSignalService`。

新增 selection signal provider，只提供数据，不做加权评分：

- recent success rate：来自 `executor_route_events` 最近 3 次结果。
- pending load：来自当前 queued/running task 与 executor 运行状态聚合。
- price：当前没有数据源，先返回 unknown。

LLM 或后续 policy decision layer 决定如何组合这些 signals。tool layer 不恢复静态 affinity scoring。

Priority 3：在 runtime 内引入 `shouldRetryOnPeer` failure judgment seam。

`fallbackChain` 不能无条件逐个尝试。runtime 在尝试 peer executor 前应先判断失败类型：

- force-majeure / environmental failure：permission、network、timeout 等，不继续尝试 peer，返回用户处理。
- capability shortfall：当前 executor 做不了，才尝试 fallback peer。

初始实现可以复用现有 `isRecoverableExecutorFailure` 语义，但必须包在可替换 interface 后面，接口命名使用 `shouldRetryOnPeer`。

Priority 4：把 execution runtime 相关代码从 `core` 拆向 `src/execution`。

`ExecutionRuntime`、`ExecutorRegistry`、fallback judgment、progress service、multi-executor orchestration、agentic loop、aggregation 应逐步收敛到 `src/execution/`。`src/executor/` 继续只放 concrete adapters。

Priority 5：最后拆 `core/types.ts`。

`core/types.ts` 混合了 task、memory、execution context、config、runtime state。拆分应放在行为 seam 稳定之后进行，并通过 re-export 平滑迁移，避免一次性改动过大。

## 5. 非目标

- 不恢复 `ExecutionPlanV2`。
- 不恢复 `race_executors`。
- 不把 `candidateExecutors` 当作 `fallbackChain`。
- 不在 routing tool layer 重新做静态加权评分。
- 不让 `TaskRouteIntent` 和 legacy `ExecutorRouter` scoring 回到新 routing 主路径。
- 不先做大规模目录搬家。
- 不把 `2026-06-24` remaining todos 重新作为当前执行清单。

## 6. 验收标准

- 新 routing 主路径不再依赖 legacy `ExecutorRouter` scoring。
- `ExecutionStrategyPlanner` 不再消费 `ExecutorRouteDecision`。
- runtime 只消费 `ExecutionPolicy`，不消费 `ExecutionPlanV2` 或旧 plan adapter。
- force-majeure failure 不会继续尝试 peer executor。
- `fallbackChain` 只表达 policy 决定的 sequential fallback，不与 candidates 混用。
- `src/core` 开始按 intent / routing / execution / task / memory / delivery 收敛。
- architecture boundary tests 防止逻辑回流 `MetaclawSession` 或 legacy routing。

## 7. 验证方式

本文档是当前架构共识总结，不包含代码行为变更。添加本文档后不需要运行完整测试。

建议验证：

```powershell
Get-Content docs\plans\2026-06-29-metaclaw-architecture-upgrade-current-plan.md
git diff -- docs/plans
```

预期结果：

- 只新增本文档。
- 不修改 `2026-06-21-metaclaw-architecture-convergence-roadmap.md`。
- 不修改 `2026-06-24-metaclaw-roadmap-remaining-todos.md`。
