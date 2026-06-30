# 智能路由层改造 — 初步实现计划

> 基于 `docs/adr/0001`–`0010` 与 `CONTEXT.md`。本计划只覆盖**已钉死**的决策;待定部分见末尾"待解决备注"。
> 范围:C2 — 重写决策层 + plan 形状,runtime 单/多机制保留,删 race。

## 目标

用 `ExecutionPolicy`(质量/隔离/验证字段齐全)取代 `ExecutionPlanV2`(只有派发),删除 `race_executors`,把路由从静态 affinity 打分改为 LLM 分类 + 三指标选 primary + fallback chain。

---

## 阶段 1:类型层(无行为变更,纯铺路)

**目的**:先把新类型立起来,旧类型暂留,共存过渡。

1. 新建 `src/core/capability-class.ts`:
   - `export type CapabilityClass = 'code_edit' | 'research' | 'messaging' | 'memory_ops' | 'office_automation' | 'conversation' | 'general';`(ADR-0008)
2. 新建 `src/core/execution-policy.ts`:
   - `ExecutionPolicy` 接口(字段见 ADR-0001 / 0004):
     - `mode: 'single_executor' | 'multi_executor'`(删 `race_executors`,ADR-0001)
     - `primaryExecutor: string`、`candidateExecutors: string[]`
     - `isolationRequired: boolean`(ADR-0004,语义=分配独立 worktree)
     - `verificationLevel: 'none' | 'compile' | 'test' | 'review'`(ADR-0007,review 暂不可用→默认 none/test)
     - `reviewerExecutor: string | null`(挂起,暂恒 null)
     - `riskLevel: 'low' | 'medium' | 'high'`
     - `estimatedCostClass: 'cheap' | 'moderate' | 'expensive'`
     - `fallbackChain: string[]`(ADR-0006)
     - `acceptanceCriteria: AcceptanceCriterion[]`(从旧 plan 继承)
     - `capabilityClasses: CapabilityClass[]`(分类器产出,形状待定→暂按单类)
     - `reason: string`
3. 不删 `ExecutionPlanV2`,不删 `TaskRouteIntent`——本阶段仅新增。

**验证**:`npm run lint` 通过(类型可被引用但未接线)。

---

## 阶段 2:分类器改造(ADR-0010)

**目的**:让现有 LLM 桥产出 `CapabilityClass`,停止产出 `TaskRouteIntent`。

4. 改 `src/core/semantic-intent-router.ts`:
   - `buildPrompt` 的输出 schema:要求 LLM 产出 `CapabilityClass`(替换/并列于 `primaryIntent`)。
   - `SemanticIntentDecision` 增加 `capabilityClass: CapabilityClass` 字段。
5. 改 `src/core/intent-orchestrator.ts`:
   - `IntentDecisionV2` 透传 `capabilityClass`;移除对 `race_executors` mode 的推断(ADR-0001,决策层不再产出 race)。

**待定**:分类器输出形态(单类 / 主+辅 / 多类并行)依赖分解-DAG,本阶段**先按单类**实现,留 TODO(见末尾)。

**验证**:`tests/core/semantic-intent-router.test.ts`、`tests/core/intent-orchestrator.test.ts` 调整断言为 CapabilityClass。

---

## 阶段 3:选择信号提供层(ADR-0005)

**目的**:给 LLM 提供"同类多 executor"的三指标数据。

6. 新建 `src/core/executor-selection-signal-service.ts`:
   - `provideSignals(candidates: string[]): SelectionSignal[]`
   - 信号1(成功率):查 `ExecutorRouteEventRepo`,按 `selected_executor` 取最近 3 条 `result`,算成功率。**数据已存在**(已回写)。
   - 信号2(待处理负载):聚合 task 状态 + `runningExecutorNameByTask`。**缺一个按 executor 聚合的查询**——在 `TaskRuntimeService` 加 `listTasksByExecutor(name)` 或在 session 层聚合(薄方法,非新模型)。
   - 信号3(价格):**无存储**——本阶段返回 `undefined`(unknown),LLM 退化为只用信号1+2。价格字段作为后续独立任务。
7. 工具层只提供数据,**不做加权、不排序**——交给 LLM 决定(ADR-0005 的职责切分)。

**验证**:单测验证三信号数据来源正确(成功率聚合、负载聚合);价格 unknown 时降级不报错。

---

## 阶段 4:Policy 规划器(替换 resolveMode)

**目的**:用 `ExecutionPolicyPlanner` 取代 `ExecutionPlanningService.resolveMode` + `ExecutorRouter` 打分。

8. 新建 `src/core/execution-policy-planner.ts`(handoff 点名的模块):
   - 输入:`ExecutionPlanningInput`(复用)+ 分类器的 `capabilityClass` + 选择信号。
   - 输出:`ExecutionPolicy`。
   - 逻辑:
     - `capabilityClass` → 候选 executors(查能力表,ADR-0009 注册制;本阶段先查现有 `ExecutorProfile.capabilities` 做映射)。
     - 可用性 + 订阅过滤(ADR-0005 候选筛选)。
     - 同类多候选 → 三指标交 LLM 选 primary,其余按指标排序成 `fallbackChain`(ADR-0006)。
     - `isolationRequired`:`multi_executor` 或文件修改类 → true(ADR-0004)。
     - `verificationLevel`:**review 整体挂起**(ADR-0007)→ 默认 `none`,`code_edit` 类默认 `test`(复用现有 `TestEvidenceVerifier`);reviewerExecutor 恒 null + TODO。
9. 改 `ExecutionPlanningService`:
   - `plan()` 内部改调 `ExecutionPolicyPlanner`,产出 `ExecutionPolicy`。
   - **过渡**:`ExecutionPlanV2` 暂时保留为 `ExecutionPolicy` 的适配视图(供 runtime 逐步迁移),或直接让 runtime 读 policy——见阶段5。

**验证**:`tests/core/execution-planning-service.test.ts` 重写为断言 `ExecutionPolicy`。

---

## 阶段 5:Runtime 接 policy + 删 race(ADR-0001)

**目的**:执行端读新 policy,移除 race 路径。

10. 改 `src/core/execution-runtime.ts`:
    - 删 `resolveRuntimeExecutors` 的 race 分支(pi/hermes 硬编码,[execution-runtime.ts:301-316](src/core/execution-runtime.ts#L301))。
    - 删 `executeWithOptionalRace` 的并行 settle 逻辑([execution-runtime.ts:331-382](src/core/execution-runtime.ts#L331))→ 退化为单 executor 执行。
    - `executeCodexFallback`(硬编码 codex 兜底,[execution-runtime.ts:393](src/core/execution-runtime.ts#L393))→ 改为读 `policy.fallbackChain`,按链顺序试。
    - 接 `ExecutionPolicy` 替代 `ExecutionPlanV2`(或通过适配层)。
11. 改 `src/core/executor-routing-coordinator.ts`:
    - 删 `formatRaceDispatchLine` / `resolveRaceExecutorNames`([executor-routing-coordinator.ts:115-119](src/core/executor-routing-coordinator.ts#L115))。
12. 改 `src/session/session-execution-coordinator.ts`:
    - 移除 race 相关分支([session-execution-coordinator.ts:126-128](src/session/session-execution-coordinator.ts#L126)、`abortedExecutors` 展示)。
    - 失败处理接 ADR-0006 的判断层(初版复用 `isRecoverableExecutorFailure`,但封装为可替换接口 `shouldRetryOnPeer(failure): boolean`,语义陷阱已在 ADR-0006 记录)。

**验证**:删/改涉及 race 的测试:`tests/core/execution-runtime.test.ts`(race case)、`tests/core/intent-orchestrator.test.ts`(race_executors mode)、`tests/core/intent-golden.test.ts`、`tests/session/executor-router-command-acceptance.test.ts`。

---

## 阶段 6:类型清理(收尾,最后做)

**目的**:旧类型在无生产者后删除(ADR-0002 无 shim)。

13. 删 `TaskRouteIntent` 及 `DEFAULT_INTENT_AFFINITY` 表(`executor-router.ts`)——确认全仓无生产者后。
14. 删 `ExecutorRouter` 的打分逻辑(`scoreFallbackProfile` 等)——被 `ExecutionPolicyPlanner` 取代。
15. 删 `ExecutionPlanV2` / `ExecutionPlanModeV2`(确认 runtime 已不引用)。
16. 删 `historicalSuccess` 字段及相关(seed、repo、profile)——被 `executor_route_events` 成功率取代(ADR-0001/0005)。

**验证**:全量 `npm test` + `npm run lint` 通过。

---

## 待解决备注(本计划跳过,需后续设计)

- **分解-DAG**:异步依赖(B 等 A)、多任务优先级、协调范式(coordination)。整个路由层最复杂部分,需专门设计。(ADR-0003/0004 已挂起)
- **分类器输出形态**:单类 / 主+辅 / 多类并行。依赖分解结构,暂按单类实现。(ADR-0010 已挂起)
- **能力表"调用方法"粒度**:工具级 schema vs 能力级摘要 vs 两层。由执行器自决或后续规定。(ADR-0009 已挂起)
- **Reviewer / 高风险 hook 审核**:需新建 hook 机制(执行前后拦截);`TaskStatus` 缺 `pending_review` 状态需补;代码类 reviewer 改用三指标顺延选(不固定)。(ADR-0007 已挂起)
- **价格数据(信号3)**:无存储,需新建字段/来源。本计划降级为 unknown。(ADR-0005)
- **失败判断 skill**:初版用 `isRecoverableExecutorFailure` 正则,将来替换为 skill。(ADR-0006)
- **拆解 skill**:任务分解的引导逻辑,独立于路由。(ADR-0003/0010)
- **能力表注册制落地**:新增 MCP 的 6 步流程(执行器自测→返回调用方法→用户确认→落库)。本计划阶段4先用现有 capabilities 做映射,注册流程后续实现。(ADR-0009)

---

## 迁移安全

- 分 6 阶段,每阶段可独立 `npm test` 通过。
- 阶段1-2 新旧共存,不破坏现有行为。
- race 的删除集中在阶段5,有明确测试清单。
- 旧类型删除在阶段6最后,确认无引用后再删,避免提前破坏编译。
