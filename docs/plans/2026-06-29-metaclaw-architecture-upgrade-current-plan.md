# MetaClaw 仓库结构梳理方案

日期：2026-06-29

## 1. 背景与本轮范围

`src/core` 目前是一个 52 文件的 catch-all 目录，把 memory、task、execution、delivery、learning、guidance、intent、routing、shared-types 等所有职责混在一起，是当前可读性最大的瓶颈。此前已把 execution / delivery 的一部分抽到 `src/execution`、`src/delivery`（提交 `c6899c3`）。

**本轮目标：纯文件/模块搬家 + 目录结构梳理，不做任何逻辑重构。** 把 `src/core` 里与路由无关的职责拆进清晰的领域包，得到一个功能结构清晰、高可读的仓库。

本轮原则（沿用并强化之前的约定）：

- **只搬家，不改逻辑**：用 `git mv` 移动文件，只更新 import 路径，不改动任何函数/类的实现。
- **路由规则相关代码完全不碰**，留待后续「智能路由阶段」统一改造。
- **不留 re-export 兼容 shim**：所有引用方一次性改成直接指向新位置。
- 唯一例外：有 5 个非路由文件被 3 个路由文件 import，搬走它们会导致那 3 个路由文件的 import **路径字符串**失效。本轮允许对这 3 个文件做**机械的路径更新（零逻辑改动）**，详见第 5 节。

`docs/plans/2026-06-21-metaclaw-architecture-convergence-roadmap.md` 仍是总路线北极星；`docs/plans/2026-06-24-metaclaw-roadmap-remaining-todos.md` 不作为当前待办。本轮只做结构梳理，不重开这两份文档。

## 2. 目标目录结构

```text
src/
  memory/      # 记忆引擎、召回、召回复核、偏好/任务嵌入、上下文 bundle 构建、记忆捕获
  task/        # 任务模型/引擎、生命周期/运行时、调度、检索/排序/语义、阻塞重算、恢复规划
  execution/   # 执行运行时、executor registry、agentic loop、多 executor 编排、进度、聚合、workspace、会话运行时
  executor/    # 具体 executor 适配器 + executor profile/admin/seeder 注册表管理
  learning/    # 反思引擎、周报、技能治理、晋升闸门、安全扫描
  guidance/    # 主动引导：任务信号、引导策略、编排/看板优先级
  intent/      # 输入/资源归一化等非路由意图助手
  delivery/    # 验收流水线、产物抽取、最终格式化、通知投递
  session/     # 会话编排/状态/输出门面、用户交互协调、会话持久化
  routing/     # 路由层（本轮不动，留待智能路由阶段）
  core/        # 仅剩路由/意图裁决 + 共享类型残留（见第 4 节）
  storage/ gateway/ commands/ tui/ cli/ utils/ notifications/ integrations/   # 维持现状
```

目录拆分服务于 seam：每个领域包对外是小 interface、内部是深 implementation，而不是把复杂度机械搬到新文件夹。

## 3. 搬家映射（39 个文件离开 core）

> 每个文件 `git mv`，仅更新自身与引用方的 import 路径，内容逻辑不动。

| 目标包 | 文件 |
|---|---|
| `src/memory/`（11） | memory-engine, memory-capture-service, memory-context-service, memory-vault-exporter, hybrid-memory-recaller, context-recaller, resume-context-builder, recall-policy-service, recall-review-application-service, recall-review-builder, preference-embedding-service |
| `src/task/`（10） | task-engine, task-runtime-service, task-execution-planner, task-resume-planner, task-relevance-ranker, task-semantic-service, task-embedding-service, hybrid-task-retriever, blocked-task-reconciler, scheduler |
| `src/execution/`（+4，已有 3） | execution-runtime, agentic-loop-controller, multi-executor-orchestrator, conversation-runtime-service |
| `src/executor/`（+3，已有适配器） | executor-profile-service, executor-admin-service, executor-registry-seeder |
| `src/learning/`（5，新建） | reflection-engine, learning-weekly-review-builder, skill-governance-engine, promotion-gate, safety-scanner |
| `src/guidance/`（3，新建） | orchestration, guidance-policy-engine, task-signal-service |
| `src/intent/`（2，新建） | inline-resource-normalizer, material-utils |
| `src/session/`（+1） | session-persistence-service |

说明：

- `safety-scanner` 主用于 learning 的反思候选安全；`src/executor/skill-package-builder` 会跨域 import 它，属正常依赖。
- `conversation-runtime-service` 仅被 `metaclaw-session` 使用，归入 execution 运行时。
- `task-signal-service` 是 guidance 流水线的输入，与 `guidance-policy-engine`、`orchestration` 一起进 `src/guidance`。

## 4. 留在 src/core 的残留（13 文件，本轮不动）

- **路由 / 意图裁决（→ 智能路由阶段接手）**：capability-class, execution-policy, execution-strategy-planner, execution-planning-service, executor-router, executor-routing-coordinator, semantic-intent-router, intent-orchestrator, rule-hints-provider, llm-bridge, task-routing
- **共享原语（→ types 拆分阶段处理）**：types.ts, embedding-provider.ts

搬完后 `src/core` = 11 个路由文件 + 2 个共享文件，恰好是未来「智能路由阶段」要接手的范围，交接干净。

> 备注：`task-routing.ts` 实质是任务过滤谓词（`filterDurableTasks` 等），并非路由规则；但它被路由文件 `rule-hints-provider` / `semantic-intent-router` import，单独搬会强制改动路由文件，故本轮保留在 core。
> `llm-bridge.ts` 是通用 LLM 客户端但混入了 legacy 路由 schema 且被路由文件依赖，本轮保留；将来可在路由阶段把通用 LLM 适配层与路由 schema 拆开。

## 5. 路由 seam 与 3 处「机械改路径」

经逐文件核实 import：**没有任何路由文件 import memory / learning / guidance / intent 域**，这些域可零路由改动搬走。唯一耦合是 5 个待搬文件被 3 个路由文件 import。搬走它们时，仅对下列 3 个路由文件做 **import 路径字符串更新（不改任何路由逻辑）**：

- `src/core/executor-routing-coordinator.ts`
  - `./executor-profile-service.js` → `../executor/executor-profile-service.js`
  - `./task-runtime-service.js` → `../task/task-runtime-service.js`
  - `./session-persistence-service.js` → `../session/session-persistence-service.js`
- `src/core/execution-planning-service.ts`
  - `./multi-executor-orchestrator.js` → `../execution/multi-executor-orchestrator.js`
- `src/core/execution-strategy-planner.ts`
  - `./hybrid-task-retriever.js` → `../task/hybrid-task-retriever.js`

> 这些是纯路径更新，未来路由阶段无论怎么重写这些文件都会重排 import，本轮改动对其零负担。

## 6. 分阶段执行顺序

按「先叶子后核心、最少级联」排序。每个 Phase 一个可验证提交，步骤固定：`git mv` → `tsc --noEmit` 找出断裂 import 并修路径 → 镜像迁移对应测试文件并改其 import / readSource 路径 → 更新/新增 boundary test → Docker 跑 `npm test` → 提交。

- **Phase A — intent 助手** → `src/intent/`（叶子，零路由）
- **Phase B — memory 域** → `src/memory/`（零路由）
- **Phase C — learning 域**（含 safety-scanner）→ `src/learning/`（零路由）
- **Phase D — guidance 域** → `src/guidance/`（零路由）
- **Phase E — execution runtime** → `src/execution/`（含 1 处路由改路径：execution-planning-service）
- **Phase F — executor 服务** → `src/executor/`（含 1 处路由改路径：executor-routing-coordinator）
- **Phase G — task 域** → `src/task/`（含 2 处路由改路径：executor-routing-coordinator、execution-strategy-planner）
- **Phase H — session-persistence-service** → `src/session/`（含 1 处路由改路径：executor-routing-coordinator）
- **Phase I（本轮不做，标注为后续）** — 拆 `types.ts`、安置 `embedding-provider.ts`；blast radius 大，留待行为 seam 稳定后单独处理。

## 7. Boundary tests 处理

- **路径需更新**（readSource 指向旧 core 路径）：`task-runtime-boundary`、`memory-context-boundary`、`execution-runtime-boundary`、`metaclaw-session-architecture-boundary`（按其引用到的被搬文件）。
- **不变**（断言对象仍在 core）：`executor-factory-boundary`、`llm-bridge-boundary`、`execution-planning-boundary`（llm-bridge / execution-planning-service / executor-router 都留在 core）。
- **已完成**：`execution-module-boundary`、`verification-and-delivery-boundary`。
- 每个新域加一条轻量 boundary test：断言实现已在 `src/<domain>/`、且旧 `src/core/<file>.ts` 不存在（复用 `existsSync` 模式）。
- 测试文件随源码**镜像迁移**：`tests/core/<x>.test.ts` → `tests/<domain>/<x>.test.ts`（AGENTS.md 约定 tests 镜像 src）。

## 8. 非目标

- 不改动任何路由规则 / 路由层逻辑（仅第 5 节的机械路径更新）。
- 不拆 `types.ts`（留 Phase I）。
- 不保留旧路径的 re-export 兼容 shim。
- 不做任何逻辑重构、不改函数行为、不改公共契约。
- 不重开 `2026-06-24` remaining todos。

## 9. 验收与验证

- 每阶段 `npm run lint`（`tsc --noEmit` 零报错，确认无悬空 import）。
- 每阶段 Docker 全量测试保持全绿：

```bash
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
```

- 终态自检：
  - `src/core` 仅剩 13 个文件（11 路由 + types + embedding-provider）。
  - 已搬模块的旧 `core/` 路径不再被任何文件引用（除第 5 节 3 个路由文件对残留 core 文件的正常引用）。
  - `git diff -- docs/plans` 仅改本文件；不动 `2026-06-21` roadmap 与 `2026-06-24` todos。
