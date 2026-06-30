# 待解决 Issues(临时移交)

> 来源:`main` 合并后的全面 code review + Docker 测试(2026-06-30)。
> 本文件为临时清单,供后续 agent 接手。已处理项不在此列(门禁 i18n 已修复,门禁单任务策略已在 ADR-0011 / CONTEXT.md 记录为刻意决策)。

## P0 — 阻塞推送:5 个验收测试因单活跃任务门禁失败

`TaskAdmissionGate`(刻意加入,见 [ADR-0011](docs/adr/0011-single-active-task-admission-gate.md))关闭了"第二个顶层任务"的排队/抢占/自动恢复,但以下沿用旧多任务行为的验收测试未同步更新,现在 Docker 里 `npx vitest run` 退出码 1(5 failed / 824 passed):

- `tests/tui/auto-resume-preempted.test.ts` — "resumes the preempted parked task before a later normal queued task"
- `tests/tui/guidance-blocks.test.ts` — "shows a completion guidance block that points to the next queued task"
- `tests/tui/guidance-panel.test.ts` — "updates the guidance panel after task completion points to the next queued task"
- `tests/tui/memory-resume-acceptance.test.ts` — "keeps task-local memory ahead of global memory when a parked task resumes after preemption"(execute 实际 1 次,期望 3 次)
- `tests/session/cross-session-last-task-round12-acceptance.test.ts` — "allows the user to choose resuming the most recent unfinished task..."

**处理方向**:按 ADR-0011,这些是"旧多任务行为"的过时测试 → 重写或移除以匹配单活跃任务语义。**测试不全绿不要推送。**

复现:
```bash
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test bash -lc "npx vitest run"
```

## P2 — 路由决策置信度被硬编码

[`src/routing/execution-policy-planner.ts:188`](src/routing/execution-policy-planner.ts#L188) `buildRouteDecisionFromPolicy` 把 `confidence` 写死为 `0.85`,丢弃了来自 `IntentDecisionV2` / `IntentDecision` 的真实置信度。后果:route event 记录与界面 `confidence=0.85` 失真,路由质量遥测不可信(action 由 riskLevel 推导,**不会**误触发自动派发,仅影响展示/统计)。
**处理方向**:让 `ExecutionPolicy` 透传真实 confidence(或在 policy 上新增字段),`buildRouteDecisionFromPolicy` 使用之。

## P2 — routing-coordinator 输出半角英文,与 zh-CN 界面不一致

[`src/core/executor-routing-coordinator.ts:92-100`](src/core/executor-routing-coordinator.ts#L92) `formatRoutingDecision` 输出 `-> MetaClaw: route decision ...` 等半角英文行,而界面整体是全角 `→ MetaClaw：…`(参见 `conversation-runtime-service.ts`、`metaclaw-session.ts`)。与已修复的门禁文案同类问题。
**处理方向**:统一为 `→ MetaClaw：` 全角中文风格。

## P3 — LlmBridge 内联 per-executor 参数分支(抽象高度)

[`src/core/llm-bridge.ts:129`](src/core/llm-bridge.ts#L129) `buildCommandArgs` 用 `if (this.command === 'pi')` 硬编码 pi 专属 flags,与 codex 分支、默认分支并列。每加一个推理执行器都要改 LlmBridge。
**处理方向**:下沉到 adapter 层(参照 `buildCodexNonInteractiveArgs`),而非塞进 LLM 桥。

## P3 — `unique()` 重复实现

`unique()` 在 4 处各写一遍且 `filter(Boolean)` 行为略有差异:
- [`src/execution/execution-runtime.ts:49`](src/execution/execution-runtime.ts#L49)
- [`src/routing/execution-policy-planner.ts`](src/routing/execution-policy-planner.ts)
- `src/core/executor-router.ts`
- `src/core/execution-strategy-planner.ts`

**处理方向**:抽到 `src/utils/` 单一实现并替换调用方。

---

### 已确认无需处理(review 中排除的误报)
- `docker/pi.env` 含真实 key 但已被 `.gitignore`/`.dockerignore` 忽略且未被 git 跟踪,不会推送;被跟踪代码里唯一 `sk-` 为测试假数据。
- 模块重组(`src/core/*` → 分模块):`tsc --noEmit` 通过,无悬空 import,无残留 `race_executors` / 旧 `capabilityClass` 字段读取方。
