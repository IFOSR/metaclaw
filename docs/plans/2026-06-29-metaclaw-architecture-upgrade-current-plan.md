# MetaClaw 当前架构升级方案

日期：2026-06-29

## 1. 背景

`docs/plans/2026-06-21-metaclaw-architecture-convergence-roadmap.md` 仍然是 MetaClaw 架构收敛的总路线。那份 roadmap 的核心判断是正确的：系统要从 session-centric 结构收敛到清晰的主路径，让自然语言裁决、任务生命周期、上下文构建、执行规划、执行运行时、验收交付分别位于明确的 module seam 后面。

截至当前实现，`2026-06-21` roadmap 中的大量主路径收敛已经完成：`InputController`、`IntentOrchestrator`、`TaskRuntimeService`、`MemoryContextService`、`ExecutionPlanningService`、`ExecutionRuntime`、`VerificationAndDeliveryService`、`SessionExecutionCoordinator` 都已经进入主路径。`MetaclawSession` 的 God Object 问题已经明显缓解。

新的主要问题从 `MetaclawSession` 转移到了 `src/core`。许多职责虽然已经从 session 中迁出，但仍混在 `core` 目录内：intent、routing、execution runtime、task runtime、memory、delivery、types 等都在同一个大包里。当前架构升级的重点因此进入第二阶段：不再只是收缩 `MetaclawSession`，而是收缩 `src/core`，把职责拆分成清晰的领域包。

`docs/plans/2026-06-24-metaclaw-roadmap-remaining-todos.md` 暂时不作为新的待办清单推进。当前方案只吸收其中已经完成的事实，不重新打开那份文档里的 remaining todos。

## 2. 本轮范围与边界

本轮**只做智能路由之外的架构拆分**。

- 本轮聚焦：把 `src/core` 里智能路由之外的职责拆分成清晰领域包（execution / delivery / task / memory / intent 等），让每个 module 拥有小 interface 和深 implementation。
- 本轮**不碰**智能路由，也不动现有路由层：routing seam、selection signals、execution policy、runtime 内的 fallback 失败判定等，全部留待后续「智能路由阶段」统一改造。这样做的原因是：现在按当前形状改一遍 routing，等真正实现智能路由时还要再改一遍，重复劳动且容易引入互相矛盾的中间态。届时统一改。
- 和 `2026-06-21` roadmap 的关系：保留其 7 层主路径作为北极星；其中执行规划 / routing / runtime policy 那一段的**目标形态推迟到智能路由阶段再定**，本轮不把它作为执行目标。

```text
InputController
  -> IntentOrchestrator
  -> TaskRuntimeService
  -> MemoryContextService
  -> ExecutionPlanningService
  -> ExecutionRuntime
  -> VerificationAndDeliveryService
```

## 3. 当前目标架构

目标不是先做大规模目录搬家，而是让每个 module 拥有小 interface 和深 implementation。目录拆分应服务于 seam，而不是把现有复杂度机械移动到新文件夹。迁移要一次性迁干净：更新所有引用方直接指向新位置，不在旧路径保留 re-export 兼容 shim。

建议最终包结构：

```text
src/routing/     （智能路由阶段再落地，本轮不动）
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

- `src/execution/`：runtime、executor registry、progress、multi-executor orchestration、agentic loop、aggregation。
- `src/task/`：task model、task lifecycle、task execution planning、scheduling eligibility。
- `src/memory/`：memory engine、recall、execution context bundle、recall review、memory capture。
- `src/intent/`：natural-language decision、rule hints、intent schemas。（其中 semantic routing adapter 属于路由层，本轮不动。）
- `src/delivery/`：verification pipeline、artifact extraction、final formatting、notification delivery。
- `src/executor/`：concrete executor adapters and executor prompt/runtime adapter utilities。
- `src/session/`：composition/state/output facade and user interaction coordination。
- `src/routing/`：`CapabilityClass`、`ExecutionPolicy`、policy planning、strategy planning、selection signals、route event projection——**留待智能路由阶段**。

`src/core` 应逐步退化为空目录或仅保留尚未拆分的 routing/types 内容，最终被上述领域包替代。

## 4. 当前优先级（智能路由之外）

Priority 1：抽取 execution 与 delivery 模块（本提交已完成）。

- `execution-aggregator`、`execution-progress-service`、`workspace-target-service` 移到 `src/execution/`。
- `verification-and-delivery-service` 移到 `src/delivery/`。
- 所有引用方（session、coordinator、agentic-loop-controller、memory-capture-service、测试）直接指向新位置，`src/core` 不保留 re-export shim。
- boundary test 断言实现在新位置、且旧 `core` 文件已移除。

Priority 2：继续把 execution runtime 相关代码从 `core` 收敛到 `src/execution`。

- `ExecutionRuntime`、`ExecutorRegistry`、progress service、multi-executor orchestration、agentic loop、aggregation 逐步收敛到 `src/execution/`。`src/executor/` 继续只放 concrete adapters。
- 注意：runtime 内 `fallbackChain` 的 peer-retry 失败判定涉及路由语义，**不在本轮处理**，留待智能路由阶段（见第 5 节）。

Priority 3：拆 task / memory / intent / delivery 领域包。

- 按职责把 `core` 中对应代码搬到 `src/task`、`src/memory`、`src/intent`、`src/delivery`，同样要求一次性更新引用、不留兼容 shim。

Priority 4：最后拆 `core/types.ts`。

- `core/types.ts` 混合了 task、memory、execution context、config、runtime state。拆分应放在行为 seam 稳定之后进行。优先一次性把引用方更新到拆分后的类型模块；如确需临时 re-export 过渡，必须在同一轮内清除，不长期保留。

Priority 5：用 architecture boundary tests 防止逻辑回流 `MetaclawSession` 或 `core`。

## 5. 暂缓：智能路由阶段统一处理

以下条目本轮不执行，等到具体实现智能路由时统一改造，避免反复改写。此处仅记录已达成的方向共识，供后续阶段参考。

- 清理 routing seam：让 `ExecutionStrategyPlanner` 不再依赖 `ExecutorRouteDecision`，strategy planning 的输入围绕 policy 语义（`capabilityClass`、`primaryExecutor`、`candidateExecutors`、`riskLevel`、`matchedBoundary`、`resources`、`recalledTaskIds`、`taskExecutionPlan`）。`ExecutorRouteDecision` 只保留为 route event persistence/display 的 projection。
- 新增 `ExecutorSelectionSignalService`：只提供数据不做加权评分（recent success rate / pending load / price），由 LLM 或 policy decision layer 决定如何组合。tool layer 不恢复静态 affinity scoring。
- 在 runtime 内引入 `shouldRetryOnPeer` 失败判定 seam：区分 force-majeure / environmental failure（不试 peer，返回用户）与 capability shortfall（才尝试 fallback peer）。可复用现有 `isRecoverableExecutorFailure` 语义，但包在可替换 interface 后面。
- 执行规划层替换关系（届时落地）：
  - `ExecutionPlanV2` -> `ExecutionPolicy`
  - `race_executors` -> sequential fallback policy
  - static affinity / `TaskRouteIntent` -> `CapabilityClass + selection signals`
  - hardcoded fallback -> `fallbackChain + failure judgment seam`

## 6. 非目标

- 不在本轮改动智能路由或现有路由层。
- 不恢复 `ExecutionPlanV2`。
- 不恢复 `race_executors`。
- 不把 `candidateExecutors` 当作 `fallbackChain`。
- 不在 routing tool layer 重新做静态加权评分。
- 不让 `TaskRouteIntent` 和 legacy `ExecutorRouter` scoring 回到新主路径。
- 不先做大规模目录搬家。
- 迁移时不长期保留旧路径的 re-export 兼容 shim。
- 不把 `2026-06-24` remaining todos 重新作为当前执行清单。

## 7. 验收标准

本轮（结构性拆分）：

- execution / delivery 模块的实现位于 `src/execution` / `src/delivery`，`src/core` 不再保留对应文件或 re-export shim。
- 所有引用方直接 import 新位置，`tsc --noEmit` 通过。
- `src/core` 开始按 execution / delivery / task / memory / intent 收敛。
- architecture boundary tests 断言实现在新位置、旧 `core` 文件已移除，防止逻辑回流。

智能路由阶段（后续）：

- 新 routing 主路径不再依赖 legacy `ExecutorRouter` scoring。
- `ExecutionStrategyPlanner` 不再消费 `ExecutorRouteDecision`。
- runtime 只消费 `ExecutionPolicy`，不消费 `ExecutionPlanV2` 或旧 plan adapter。
- force-majeure failure 不会继续尝试 peer executor。
- `fallbackChain` 只表达 policy 决定的 sequential fallback，不与 candidates 混用。

## 8. 验证方式

本轮已包含代码行为之外的结构迁移，验证方式：

```powershell
npm run lint        # tsc --noEmit，确认无悬空 import
npx vitest run tests/core/execution-module-boundary.test.ts tests/core/verification-and-delivery-boundary.test.ts
git diff -- docs/plans
```

预期结果：

- 类型检查通过，无对已删除 `core` shim 的引用。
- boundary tests 通过：实现在 `src/execution` / `src/delivery`，旧 `core` 文件已移除。
- 不修改 `2026-06-21-metaclaw-architecture-convergence-roadmap.md`。
- 不修改 `2026-06-24-metaclaw-roadmap-remaining-todos.md`。
