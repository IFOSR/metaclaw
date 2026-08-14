# Executor Session-first 持久化与恢复简化计划

## 状态

- 状态：第一阶段已完成；第二阶段未开始
- 计划日期：2026-08-14
- 第一阶段完成日期：2026-08-14
- 实施方式：两个阶段
- 最终范围：所有用户入口统一；允许先在 Feishu Gateway 灰度验证
- 取代：
  - `2026-08-11-pi-durable-session-continuation-recovery.md`
  - `2026-08-13-session-first-persistence-simplification.md`

## 一句话方案

保留现有 Task、Kernel、worktree、权限、retry、fallback、replan 和用户入口行为，
把 Executor 自己的持久 session 作为执行上下文连续性的事实来源；数据库只保存恢复所需的
当前事实和外部副作用凭证，不再为恢复重复记录并重放完整执行过程。

## 最高优先级实施原则

以下原则高于具体类名、表结构和任务拆分。实施中如果某项设计与这些原则冲突，应缩小或放弃
该设计，而不是扩大本次改造范围：

1. **本次目标不是增加新功能，也不是改变原有产品行为。** 除已明确确认的中断收敛边界外，
   大部分产品行为保持与当前一致。
2. **主要目标是复用 Executor session，大幅降低数据库记录与恢复复杂度。** 不再为了恢复模型
   上下文，重复保存 session 已经持有的执行历史。
3. **通过减少“记录状态 → 写库 → 重建状态 → 恢复”的中间环节降低故障面。** 评价实现是否
   成功，不只看能否恢复，还要看写入点、恢复分支和可能卡住的状态组合是否实际减少。
4. **只做当前功能所必需的改动。** 不为未来 runtime、跨机器迁移、通用工作流或潜在扩展预埋
   抽象、表、事件或兼容层。
5. **保持 Kernel 为策略权威。** session 复用只替换执行历史的事实来源，不接管 retry、fallback、
   replan、权限、publication 或用户确认决策。
6. **分阶段替换，不长期双轨。** 第一阶段暂时保留旧链路用于对照和回退；第二阶段验证等价后
   必须删除失去用途的写入和恢复代码，不能把新方案叠加成第三套持久化系统。

```text
用户入口
   ↓
现有 Kernel 策略 ──→ retry / fallback / replan / 等待用户
   ↓                         ↑
当前 Task + Attempt ──→ 恢复事实判定
   ↓                         ↑
持久 Executor session + 持久 worktree + 必要副作用凭证
```

## 1. 背景与问题

现有系统为了实现中断恢复，同时维护了多套相互关联的状态：Kernel decision/event/application、
workflow、attempt runtime、checkpoint、workspace delta、outbox、publication 和进程/沙箱状态。
启动恢复需要把这些记录重新拼接成“之前进行到哪里”，链路长、状态组合多，也容易因为某一条
记录缺失、顺序不一致或恢复动作重复而卡住。

但对模型执行上下文而言，真正包含历史对话、工具调用和工具结果的是 Executor runtime 的
session。当前 Pi session 已存在，却被放在 attempt 临时目录中，并在进程结束时清理；
continuation token 又是在进程结束后才提取，因此数据库记录的 token 可能指向已删除的文件。
系统随后只能依赖自己记录的大量中间状态重建上下文，形成了不必要的第二套执行历史。

本计划不改变产品能力，而是调整恢复的事实来源：

- session 回答“模型之前看过什么、做到了哪一步”；
- worktree/commit 回答“代码和文件实际是什么状态”；
- 少量数据库当前事实回答“这是谁的任务、能否恢复、Kernel 应采取什么策略”；
- 外部系统回执和幂等键回答“副作用是否已完成、能否安全重试”。

## 2. 已确认的产品行为

以下是实施约束，不在开发过程中重新解释或扩展：

1. 大部分产品行为保持与现在一致，不新增用户可见的恢复模式。
2. 最终所有入口使用同一套 session-first 行为；可以先从 Gateway 灰度，但不能长期形成
   Gateway 和本地入口两套恢复语义。
3. Runtime 或主进程崩溃后，系统仍自动尝试恢复未完成执行。
4. 保留现有 retry、fallback、replan、权限和 publication 策略；恢复方式仍由 Kernel 根据
   当前事实决定，Adapter 不自行决定重试。
5. 对不确定的外部副作用：
   - commit 或 provider receipt 能证明已完成时，自动收敛为已完成；
   - 幂等键或当前本地记录能证明重试安全时，沿用 Kernel 策略自动重试；
   - 两者都不能证明时，不静默重试，进入现有的用户确认/阻塞路径。
6. 无法安全自动恢复的旧 Task 保留为可后续处理的 interrupted/blocked 状态，同时释放
   single-active slot、claim 和 lease，使新 Task 可以执行。
7. 自动恢复保证只覆盖同一持久数据卷且 runtime 兼容的场景。数据卷丢失、session 丢失或
   runtime 不兼容时降级为新 session 或现有 fallback，不承诺跨环境无损 continuation。

## 3. 设计边界

### 3.1 权威事实划分

| 事实 | 权威来源 | 不应由谁重复维护 |
| --- | --- | --- |
| 模型对话、工具调用与工具结果 | Executor session | Kernel event/workflow replay |
| 当前代码、文件与候选成果 | 持久 worktree、branch、HEAD/commit | session 文本或 workspace delta 日志 |
| Task/Subtask、当前 generation、attempt 结果 | 现有领域表与 terminal receipt | session |
| 是否 retry/fallback/replan | Control Kernel | Executor Adapter |
| 权限、publication、merge、delivery | 现有专用记录或 provider receipt | 通用 session 状态 |
| 运行进程归属和存活性 | 当前 runtime/process ownership 记录 | 历史事件重放 |

### 3.2 最小 session 恢复记录

优先扩展现有 `executor_attempt_runtime`（或现有最接近的单行记录），不新建通用事件账本。
只持久化无法从 session/worktree/现有领域表直接得到的字段：

- session locator/native session id；
- 所属 Task、generation、Subtask、attempt/AgentClass；
- runtime binding/driver/config digest 或等价兼容性指纹；
- project/worktree/branch/HEAD 等工作区身份；
- session 是否可恢复，以及不可恢复/poison 原因；
- 创建、确认和最后使用时间。

不保存 session 内容副本，不把 session JSONL 再拆成数据库 event，不增加通用
`RunJournal`、`SessionRuntime` 平台层或新的事件总线。

### 3.3 Session chain 与并发

- Planner 对话继续沿用稳定的 channel/chat session 映射。
- Executor session chain 绑定到 project、Task、generation、Subtask 和 runtime/AgentClass。
- 同一个 chain 串行使用 session，避免两个进程并发写同一 JSONL。
- 不同 Subtask 继续并行，各自拥有独立 session 与 worktree。
- continuation 使用同一个持久 session chain；如果底层 driver 不支持安全追加，由该 driver
  提供必要的 copy/fork，但不把 checkpoint 封装提升为全局通用协议。

### 3.4 恢复准入检查

恢复前只做必要检查，并向 Kernel 返回规范化事实：

1. **ownership**：session 属于当前 Task/generation/Subtask/AgentClass；
2. **runtime compatibility**：driver、binding 和关键配置兼容；
3. **workspace identity**：project、worktree、branch 和可接受的 HEAD 一致；
4. **session integrity**：locator 存在，header/格式可读，未被标记为 poison；
5. **side-effect safety**：外部副作用已确认完成，或有证据证明可幂等重试。

结果只需要三类：

- `resume`：可安全复用 session；
- `fresh/fallback`：session 不可用，但现有 Kernel 策略允许新 session、retry、fallback 或 replan；
- `blocked`：副作用或归属不确定，不能自动继续。

Kernel 决定最终动作。Executor/driver 只负责报告事实和执行被授权的动作。

## 4. 第一阶段：让 Executor session 真正可持久恢复

### 4.1 目标

先修正事实来源和生命周期，不立即删除现有恢复表或 workflow。完成后，正常恢复优先复用真实
Executor session，但外部产品行为和 Kernel 策略保持不变。

### 4.2 实施任务

#### A. 把 session 移出 attempt 临时目录

- 为 Executor session 配置数据卷内的持久目录，生命周期至少覆盖整个 Task/Subtask chain。
- `SandboxedExecutorAdapter` 不再把可恢复 session 放在最终会被 `finally` 删除的临时根目录。
- 临时 Home、缓存和日志仍可清理；持久 session 目录不能被 attempt 清理逻辑误删。
- 容器/镜像重建后，只要挂载同一数据卷，session locator 保持有效。

#### B. 在执行早期 pin session

- 启动 Executor 前先生成并保存预期 locator 与 ownership/runtime/workspace identity。
- driver 首次建立真实 session 后尽早确认 native id/header，而不是等 `sandbox.wait()` 后才从完整日志提取。
- 如果进程在 session 建立前退出，记录为“无可恢复 session”，由 Kernel 走现有 fresh/fallback。
- session 建立后才允许把它作为 continuation 证据；空文件或损坏文件不能被当成成功恢复。

#### C. 增加很薄的 driver 恢复能力

仅提供当前实现需要的操作，例如：

```ts
type SessionResolution =
  | { kind: "resume"; locator: string }
  | { kind: "fresh"; reason: string }
  | { kind: "blocked"; reason: string };

interface ExecutorSessionContinuationStore {
  pin(input: SessionPinInput): Promise<void>;
  resolve(input: SessionResolveInput): Promise<SessionResolution>;
}
```

- 接口隐藏 Pi session 路径/header 检查，但不隐藏 Kernel 策略。
- 不为尚未出现的 runtime 设计统一 checkpoint、fork、CAS 或内容寻址系统。
- 若现有类可以直接承载这两个操作，优先扩展现有类而不是新增抽象。

#### D. 接入现有 Kernel 恢复策略

- 启动恢复和运行时中断都将 session/workspace/runtime/side-effect 检查结果作为事实提交给 Kernel。
- Kernel 继续产生现有 continuation、retry、fallback、replan、block 等决策。
- session 恢复失败只允许一次有界的 fresh/fallback 收敛，不能在 Adapter 内形成隐藏重试循环。
- 自动恢复失败且不能安全 fallback 时，把旧 Task 标记为 interrupted/blocked，释放 active slot、claim
  和 lease；Task 本身及其诊断信息继续保留。

#### E. 保持现有专用副作用凭证

- Git candidate commit/merge 状态、publication、permission 和 delivery receipt 继续作为权威记录。
- 能由 commit/provider receipt 证明完成的恢复动作自动收敛，不再次执行。
- 已有幂等键或本地 durable receipt 的动作可按现有 Kernel 策略重试。
- 没有完成证据和幂等保证的动作进入现有用户确认/阻塞路径。

#### F. 先保留旧恢复链作为安全网

- 第一阶段不删除 Kernel workflow、event、application、checkpoint 或 outbox 表。
- 新 session 路径旁路观测并与旧结果对照；灰度期可快速退回旧逻辑。
- 只停止明显错误的行为：删除有效 session、保存失效 locator、把损坏/空 session 当成 resume。

### 4.3 第一阶段测试

- 同一数据卷内重启主进程后，未完成 Pi attempt 自动恢复并延续原 session 历史。
- session 建立前崩溃会走 fresh/fallback，不生成伪 continuation。
- session 建立后、工具执行中、模型响应中、completion 提交前等中断点均有确定结果。
- runtime binding/config 不兼容、worktree/branch/HEAD 不匹配、session 缺失/损坏时拒绝 resume。
- 两个进程不能同时写同一 session chain；不同 Subtask 仍可并行。
- retry、fallback、replan、权限、publication 和各用户入口的结果与现有行为一致。
- 已完成副作用自动收敛；幂等动作可安全重试；不确定副作用不静默重复。
- 无法恢复的 Task 释放 single-active slot，但保留可诊断和后续处理状态。

### 4.4 第一阶段完成标准

- continuation 使用的 locator 在实际运行数据卷中存在且可验证，不再指向已清理的临时目录。
- 崩溃恢复的主要上下文来自 Executor session，而不是重新拼装大段 recovery packet。
- 现有产品策略和入口行为没有被新的 session 层改写。
- 真实重启/容器重建测试稳定通过后，才开始第二阶段删减。

## 5. 第二阶段：用当前事实替换通用 workflow replay

### 5.1 目标

在第一阶段证明 session 恢复可靠后，缩短“记录状态 → 写库 → 启动重放 → 恢复”的链路。
启动时读取少量当前事实并再次交给 Kernel 判定，不再为恢复重放完整历史事件和应用记录。

### 5.2 实施任务

#### A. 建立最小启动恢复投影

每个未终结 Task 启动时只读取：

- 当前 Task/Subtask/generation/attempt；
- session locator 与恢复准入结果；
- worktree/branch/HEAD/candidate commit；
- 当前 process ownership、claim 和 lease；
- 未决 permission/publication/delivery 与必要副作用 receipt。

把它们归一成一份 `interrupted/recovery facts` 交给现有 Kernel。启动恢复不再通过回放全部
decision event、application、workspace checkpoint 和历史 effect 来推断当前状态。

#### B. 按写入点逐组停止冗余持久化

先做表/字段的生产者与消费者审计，再按以下顺序收缩：

1. 停止只服务于通用 workflow replay、且已能由当前领域行表示的新增写入；
2. 让 `recoverDurableStartup` 改为读取最小恢复投影并调用 Kernel；
3. 删除已经没有读者的 replay/application/reconciliation 分支；
4. 最后再做 schema 迁移，删除已确认无生产者、无消费者、无审计要求的表/字段。

每一组删除都必须有等价的崩溃恢复测试，避免一次性重写整个 Kernel/Storage。

#### C. 删除候选与保留边界

优先审计并删除这些“通用重放”候选：

- 仅用于重建当前状态的 `kernel_events`；
- 仅用于幂等应用历史 decision 的 `kernel_decision_applications`；
- 被专用 delivery/publication receipt 取代的通用 effect outbox 记录；
- 仅为 recovery packet 重建服务的重复 workspace progress/delta/checkpoint；
- 与 Task/Subtask/attempt 当前状态重复的 workflow 事件历史。

以下记录不因 session-first 自动删除：

- Task、Subtask、当前 work graph/generation；
- attempt terminal receipt 与必要诊断；
- session pointer、runtime/workspace identity 和 poison 状态；
- persistent worktree、candidate commit 和 publication/merge 状态；
- permission、provider delivery receipt、幂等键；
- active process ownership、claim、lease 等当前并发事实；
- 有明确审计或用户可见用途的 Kernel decision。

`kernel_decisions` 是否继续保留由实际审计/诊断消费者决定，不为了“删表数量”而删除。

#### D. 统一所有入口

- Gateway 先灰度时，只改变接入顺序和开关，不改变恢复语义。
- 灰度通过后，本地/服务端入口复用同一个最小恢复投影和 Kernel 判定。
- 删除入口专属的旧启动恢复分支，避免长期双轨。

#### E. 收敛文档与迁移

- 新增或修订 ADR，明确 session、worktree、数据库当前事实和外部 receipt 的权威边界。
- 更新系统上下文、技术概览、部署与数据卷文档。
- 旧表先停止写入并观察，再迁移/删除；不要求为了新方案转换历史 session 内容。
- 已存在且可恢复的 Task 尽量沿用旧记录；缺少可靠 session 的旧 Task 按现有 fresh/fallback/
  blocked 策略收敛，不伪造 session 历史。

### 5.3 第二阶段测试

- 对关键崩溃点运行旧路径与最小恢复投影的决策对照测试，结果应一致。
- 空库、新库、包含旧任务的升级库都能启动；不因孤儿历史 event/application 阻塞。
- 在停止每组旧写入后，重启恢复、retry/fallback/replan、permission、publication 均通过。
- 验证旧 Task 无法恢复时释放 single-active slot，新 Task 可以继续执行。
- 验证所有用户入口共享同一恢复结果。
- 数据库写入次数、启动恢复查询/分支数量和 `recoverDurableStartup` 复杂度明显下降。

### 5.4 第二阶段完成标准

- 正常启动恢复不依赖完整 Kernel/workflow 历史重放。
- 数据库不再保存 Executor session 已经保存的对话和执行过程副本。
- 已无读写者的旧恢复表、Repository 和 reconciliation 代码被删除，而非永久留作双轨。
- 产品行为回归测试证明 retry、fallback、replan、自动恢复和副作用安全边界与实施前一致。

## 6. 预期代码落点

实施时优先在现有 seam 上修改，避免大规模横向抽象：

- `src/executor/sandboxed-executor-adapter.ts`：持久 session 目录、早期 locator/native id 确认、
  临时目录清理边界；
- `src/execution/subtask-attempt-runner.ts`：把 session 事实绑定到 attempt，并提交恢复结果；
- `src/storage/`：最小 session/runtime/workspace 字段和第二阶段冗余 Repository 删除；
- `src/kernel/kernel-workflow.ts` 与 Kernel 接入点：保留策略，逐步移除通用 replay plumbing；
- `src/session/metaclaw-session.ts`（以实际路径为准）：把 `recoverDurableStartup` 收缩成最小事实读取、
  reconcile 和 Kernel 调用；
- `src/planning/planner-process-runner.ts`：只验证既有 Planner 持久 session 行为，不重复改造；
- Gateway/session registry：用于第一批灰度和稳定 session 映射，不形成独立架构。

具体表结构和类型名以实施前调用关系审计为准；计划固定的是事实边界，而不是预先锁死类名。

## 6.1 第一阶段实施记录（2026-08-14）

已交付：

- fresh-only schema 升至 v36，只扩展现有 `executor_attempt_runtime`，保存 Pi session 的
  ownership、Runtime binding/config、Project/worktree/branch/HEAD、chain locator/native ID、
  confirmation/poison 与 active writer 事实；未新增通用 journal。
- Pi session locator 位于 Runtime 数据根目录的 `executor-sessions/<project>/.../session.jsonl`，
  与 attempt-private Home 分离。临时 Home 清理不会删除持久 session。
- Runtime 在 launch 前 pin locator 并占用 active writer；Adapter 从流式 JSON output 尽早读取
  native session header，并在 JSONL 文件可验证后确认。进程在确认前退出只报告 `fresh` 事实，
  不生成 continuation token。
- 恢复准入校验 Task/generation/Subtask/AgentClass ownership、当前 binding/config、持久 worktree/
  branch、相同或同分支可接受后继 HEAD、JSONL header/格式、active writer 和外部副作用安全。
  同 chain 由数据库唯一门禁串行，不同 Subtask 使用不同 locator，原有并发保持不变。
- `KernelSnapshot` 接收规范化 `resume | fresh | blocked` 事实；`ControlKernel` 继续唯一决定 native
  continuation、保留的 bounded recovery packet/fallback 或 block。Adapter 没有恢复重试循环。
- 心跳丢失和中断 pause 只在终态事实成功落库后释放 session writer；既有 claim/lease、commit、
  permission、publication 与 delivery receipt 语义保持不变。
- Planner 已有持久 session 未重复改造；实现位于共享 Session/Execution 路径，不是 Gateway 专属。

边界确认：第一阶段保留全部 Kernel workflow/event/application/outbox/checkpoint 表、Repository 与
写入；没有实施第二阶段删表、停写、通用 workflow replay 删除或启动恢复重写。

验收：

- 针对性 Docker 测试通过：核心集合 12 个测试文件、95 个测试；最终资源释放补充验证
  1 个测试文件、18 个测试；
- `npm run lint` 通过；
- `npm run build` 通过；
- 完整 `npm test` 在 Node 22 Docker 测试镜像中通过：200 个测试文件中 197 个通过、3 个跳过，
  852 个测试中 839 个通过、13 个跳过；
- 真实 `npm run smoke:anyfusion` 通过，覆盖 AnyFusion-Pi 构建上下文、独立 Planner/Runtime 进程、
  Planner RPC、Executor 注册验证和原生持久 Planner session；
- 关闭提交：`feat: persist executor sessions for crash recovery`（本提交）。

## 7. 风险与控制

| 风险 | 控制方式 |
| --- | --- |
| Pi 显式 session 路径缺失时可能静默创建新 session | resume 前先检查文件、header 和 ownership；缺失按 fresh 事实报告 |
| JSONL 被多个进程同时追加 | 同 chain 串行和 process ownership gate |
| session 存在但 worktree 已漂移 | 用 project/worktree/branch/HEAD gate 拒绝错误 resume |
| session 含历史工具调用，但副作用完成情况未知 | commit/provider receipt/幂等键优先；否则 block/用户确认 |
| 第一阶段与旧恢复链产生双重动作 | Kernel 保持唯一决策者；新层只报告事实，不自行 retry |
| 第二阶段误删仍承担审计或 delivery 职责的表 | 先停止写入并做生产者/消费者审计，最后迁移 schema |
| 为其他 runtime 预埋通用框架导致复杂度反弹 | 先实现 Pi 所需最小接口，新 driver 出现真实差异后再提炼 |

## 8. 明确不做

- 不增加新的用户入口、恢复按钮或长期并行的产品模式。
- 不改变现有 retry/fallback/replan 次数、优先级和授权规则。
- 不实现跨数据卷、跨机器或不兼容 runtime 的无损 session 迁移。
- 不追求通用 exactly-once 平台；只复用已有 receipt、commit 和幂等能力。
- 不把 session 复制进数据库，不建立新的 event sourcing、checkpoint CAS 或内容寻址层。
- 不为了潜在未来 runtime 设计插件框架、万能 session API 或新状态机。
- 不在第一阶段一次性删库或重写 `recoverDurableStartup`。

## 9. 推荐实施顺序

1. 为现有崩溃恢复行为补齐特征测试，锁定产品行为基线。
2. 持久化 Pi session 目录和最小 locator/runtime/workspace 字段。
3. 完成早期 pin、完整性检查、同 chain 串行和 poison 处理。
4. 把规范化恢复事实接入现有 Kernel，并完成真实重启/容器重建测试。
5. 在 Gateway 灰度，确认自动恢复、fallback 和副作用收敛行为无变化。
6. 建立最小启动恢复投影，逐组替换通用 replay 读取。
7. 逐组停止冗余写入、删除无读者代码，最后迁移 schema。
8. 扩展到所有入口，删除灰度开关和旧双轨路径，更新 ADR 与架构文档。

## 10. 总体验收标准

- 同一持久数据卷和兼容 runtime 下，主进程/Executor 崩溃后仍能自动继续未完成 Task。
- 恢复后的模型能访问中断前真实 session 历史，并继续使用同一 worktree 成果。
- Kernel 仍是 retry、fallback、replan、block 和 publication 的唯一策略权威。
- 不确定副作用不会静默重复；可证明完成或可幂等重试的动作可以自动收敛。
- 无法安全恢复的旧 Task 不占用 single-active slot，同时保留诊断和后续处理能力。
- 最终所有入口行为一致。
- 与实施前相比，数据库恢复专用写入、通用 replay 记录、启动 reconciliation 分支和恢复故障面
  均显著减少，且没有用新的通用抽象把复杂度搬到别处。
