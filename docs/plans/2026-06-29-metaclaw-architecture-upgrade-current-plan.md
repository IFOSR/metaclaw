# MetaClaw 仓库结构说明与梳理方案

日期：2026-06-29

## 1. 背景与本轮范围

本轮改造前，`src/core` 是一个 52 文件的 catch-all 目录，把 memory、task、execution、delivery、learning、guidance、intent、routing、shared-types 等职责混在一起，是当时可读性最大的瓶颈。此前已把 execution / delivery 的一部分抽到 `src/execution`、`src/delivery`（提交 `c6899c3`）。

**本轮目标已完成：纯文件/模块搬家 + 目录结构梳理，不做任何逻辑重构。** 当前结构已经把 `src/core` 里与路由无关的职责拆进清晰的领域包，得到一个功能结构清晰、高可读的仓库。`src/core` 终态保留 13 个文件：11 个路由/意图/策略相关文件，加 `types.ts` 与 `embedding-provider.ts` 两个共享基础文件。

本轮原则（沿用并强化之前的约定）：

- **只搬家，不改逻辑**：用 `git mv` 移动文件，只更新 import 路径，不改动任何函数/类的实现。
- **路由规则相关代码完全不碰**，留待后续「智能路由阶段」统一改造。
- **不留 re-export 兼容 shim**：所有引用方一次性改成直接指向新位置。
- 唯一例外：有 5 个非路由文件被 3 个路由文件 import，搬走它们会导致那 3 个路由文件的 import **路径字符串**失效。本轮允许对这 3 个文件做**机械的路径更新（零逻辑改动）**，详见第 5 节。

`docs/plans/2026-06-21-metaclaw-architecture-convergence-roadmap.md` 仍是总路线北极星；`docs/plans/2026-06-24-metaclaw-roadmap-remaining-todos.md` 不作为当前待办。本轮只做结构梳理，不重开这两份文档。

## 2. 当前目录结构

```text
src/
  cli/            # CLI 参数解析：--script、--gateway、--connect
  commands/       # Slash command 路由和命令处理
  core/           # 路由/意图/执行策略 seam，以及共享基础类型
  delivery/       # 验收、产物抽取、聚合检查和最终交付准备
  execution/      # 执行 runtime、fallback chain、多 executor 编排、聚合、进度、workspace、对话 runtime
  executor/       # Executor adapter，以及 profile/admin/seeder、prompt、skill package
  gateway/        # 本地 Gateway server/client 和飞书 Gateway runtime
  guidance/       # 主动引导、任务信号、引导策略和仪表盘编排
  integrations/   # 外部集成辅助能力，例如 Markdown preview
  intent/         # 内联资源归一化和非路由意图/材料辅助函数
  learning/       # 反思、周报、技能治理、晋升门禁和安全扫描
  memory/         # 记忆捕获、召回、召回审查、偏好、上下文 bundle 和 vault 导出
  notifications/  # 通知适配器，例如飞书通知
  routing/        # ExecutionPolicy planner 和正在演进的 routing policy 层
  session/        # 交互/script/gateway session 协调和持久化
  storage/        # SQLite migrations 和 repositories
  task/           # 任务状态机、runtime、调度、恢复规划、排序、语义/embedding 检索
  tui/            # Ink 终端 UI
  utils/          # 配置、路径、日志、ID 等通用工具
```

目录拆分服务于 seam：每个领域包对外是小 interface、内部是深 implementation，而不是把复杂度机械搬到新文件夹。

测试按同样分区镜像到 `tests/<domain>/`。后续新增代码时，领域实现应优先进入对应目录，不再回流到 `src/core`。

## 3. 已完成搬家映射（39 个文件离开 core）

> 每个文件已通过 `git mv` 搬迁，仅更新自身与引用方的 import 路径，内容逻辑不动。

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

## 4. 当前留在 src/core 的范围（13 文件）

- **路由 / 意图裁决（→ 智能路由阶段接手）**：capability-class, execution-policy, execution-strategy-planner, execution-planning-service, executor-router, executor-routing-coordinator, semantic-intent-router, intent-orchestrator, rule-hints-provider, llm-bridge, task-routing
- **共享原语（→ types 拆分阶段处理）**：types.ts, embedding-provider.ts

当前 `src/core` = 11 个路由文件 + 2 个共享文件，恰好是未来「智能路由阶段」要接手的范围，交接干净。

> 备注：`task-routing.ts` 实质是任务过滤谓词（`filterDurableTasks` 等），并非路由规则；但它被路由文件 `rule-hints-provider` / `semantic-intent-router` import，单独搬会强制改动路由文件，故本轮保留在 core。
> `llm-bridge.ts` 是通用 LLM 客户端但混入了 legacy 路由 schema 且被路由文件依赖，本轮保留；将来可在路由阶段把通用 LLM 适配层与路由 schema 拆开。

## 5. 路由 seam 与 3 处「机械改路径」

经逐文件核实 import：**没有任何路由文件 import memory / learning / guidance / intent 域**，这些域已零路由逻辑改动搬走。唯一耦合是 5 个已搬文件曾被 3 个路由文件 import。搬走它们时，仅对下列 3 个路由文件做了 **import 路径字符串更新（不改任何路由逻辑）**：

- `src/core/executor-routing-coordinator.ts`
  - `./executor-profile-service.js` → `../executor/executor-profile-service.js`
  - `./task-runtime-service.js` → `../task/task-runtime-service.js`
  - `./session-persistence-service.js` → `../session/session-persistence-service.js`
- `src/core/execution-planning-service.ts`
  - `./multi-executor-orchestrator.js` → `../execution/multi-executor-orchestrator.js`
- `src/core/execution-strategy-planner.ts`
  - `./hybrid-task-retriever.js` → `../task/hybrid-task-retriever.js`

> 这些是纯路径更新，未来路由阶段无论怎么重写这些文件都会重排 import，本轮改动对其零负担。

## 6. 已完成分阶段顺序

本轮按「先叶子后核心、最少级联」排序执行。每个 Phase 一个可验证提交，步骤固定：`git mv` → `tsc --noEmit` 找出断裂 import 并修路径 → 镜像迁移对应测试文件并改其 import / readSource 路径 → 更新/新增 boundary test → Docker 跑 `npm test` → 提交。

- **Phase A — intent 助手** → `src/intent/`（叶子，零路由，已完成）
- **Phase B — memory 域** → `src/memory/`（零路由，已完成）
- **Phase C — learning 域**（含 safety-scanner）→ `src/learning/`（零路由，已完成）
- **Phase D — guidance 域** → `src/guidance/`（零路由，已完成）
- **Phase E — execution runtime** → `src/execution/`（含 1 处路由改路径：execution-planning-service，已完成）
- **Phase F — executor 服务** → `src/executor/`（含 1 处路由改路径：executor-routing-coordinator，已完成）
- **Phase G — task 域** → `src/task/`（含 2 处路由改路径：executor-routing-coordinator、execution-strategy-planner，已完成）
- **Phase H — session-persistence-service** → `src/session/`（含 1 处路由改路径：executor-routing-coordinator，已完成）
- **Phase I（本轮不做，标注为后续）** — 拆 `types.ts`、安置 `embedding-provider.ts`；blast radius 大，留待行为 seam 稳定后单独处理。

## 7. Boundary tests 处理

- **路径已更新**（readSource 从旧 core 路径指向新领域路径）：`task-runtime-boundary`、`memory-context-boundary`、`execution-runtime-boundary`、`metaclaw-session-architecture-boundary`。
- **不变**（断言对象仍在 core）：`executor-factory-boundary`、`llm-bridge-boundary`、`execution-planning-boundary`（llm-bridge / execution-planning-service / executor-router 都留在 core）。
- **新域 boundary tests 已补齐**：断言实现已在 `src/<domain>/`、且旧 `src/core/<file>.ts` 不存在（复用 `existsSync` 模式）。
- **测试文件已随源码镜像迁移**：`tests/core/<x>.test.ts` → `tests/<domain>/<x>.test.ts`（AGENTS.md 约定 tests 镜像 src）。

## 8. 非目标

- 不改动任何路由规则 / 路由层逻辑（仅第 5 节的机械路径更新）。
- 不拆 `types.ts`（留 Phase I）。
- 不保留旧路径的 re-export 兼容 shim。
- 不做任何逻辑重构、不改函数行为、不改公共契约。
- 不重开 `2026-06-24` remaining todos。

## 9. 验收与验证

- 每阶段已运行 `npm run lint`（`tsc --noEmit` 零报错，确认无悬空 import）。
- 每阶段 Docker 全量测试保持全绿；终态复验命令：

```bash
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
```

- 终态自检：
  - `src/core` 仅剩 13 个文件（11 路由 + types + embedding-provider）。
  - 已搬模块的旧 `core/` 路径不再被任何文件引用（除第 5 节 3 个路由文件对残留 core 文件的正常引用）。
  - 不动 `2026-06-21` roadmap 与 `2026-06-24` todos。
