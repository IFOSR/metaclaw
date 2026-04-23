# Metaclaw PRD V2.0
## 主动编排与双层 Memory 升级方案

---

## 1. 文档定位

本文档定义 Metaclaw 下一阶段的核心产品升级方向，聚焦两个最能体现产品“质感”的能力：

1. **Proactivity 2.0：从提醒器升级为半自动推进的工作编排器**
2. **Memory 2.0：从关键词偏好记忆升级为双层 memory + embedding 语义召回**

本文档是对现有 V1 PRD 的增量升级说明，重点回答以下问题：

- 系统应如何主动组织用户的下一步工作，而不是只给静态提示
- 系统应如何同时记住“这件具体工作做过什么”和“用户通常怎么做”
- memory 召回的内容如何在执行前被用户确认，避免系统误召回后直接自动执行
- 主动性与 memory 如何形成统一工作流，而不是两个互不相干的 feature

### 1.1 当前实现状态（2026-04-20）

当前代码已经落地以下 V2 能力：

- proposal-first orchestration：启动建议、完成后建议可进入 `操作提案`
- recall review gate：memory 命中时，执行前先进入 `记忆召回确认`
- hybrid recall：规则召回与 embedding 召回可合并、去重、审计
- recall audit：每次 hybrid recall 会落到 `memory_recall_events`
- review policy：支持 `a` 授权后续自动采用，并通过 `/memory review-policy` 管理

当前 embedding 范围：

- Preference Memory：已确认偏好可生成 embedding
- Task Memory：任务标题/目标/summary、最新 snapshot、material summary 可生成 embedding
- 暂未对原始 interactions 全量 embedding，避免早期噪声过高

---

## 2. 核心判断

### 2.1 当前版本的局限

V1 已经证明了以下三件事是成立的：

- 任务可以作为长期对象存在
- 中断后的任务可以恢复
- 偏好可以被逐步沉淀并召回

但 V1 仍然存在两个明显短板：

1. **主动性还停留在“建议文本”层**  
   系统会提示，但还不能把建议变成“用户确认后立即推进”的可执行动作。

2. **memory 仍然以偏好召回为主，缺少任务级语义记忆**  
   系统能记住“通常怎么做”，但还不够擅长记住“之前具体做过什么、当前任务可以复用什么”。

### 2.2 V2 的目标

V2 要把 Metaclaw 从：

> 一个会管理任务、会记住偏好的 TUI 助手

升级为：

> 一个能主动组织工作、能在执行前给出可判断上下文、并在用户确认后半自动推进的工作中枢

---

## 3. V2 核心承诺

### A. 主动性升级

系统不再只输出“建议”，而是输出**可执行提案（Actionable Proposal）**：

- 系统说明现在最值得推进什么
- 系统说明为什么是它、为什么是现在
- 用户确认后，系统直接进入恢复、排队或执行

### B. 双层 Memory 升级

系统不再把 memory 理解为单一“偏好库”，而是拆成两层：

- **Task Memory**：记录这件具体工作做过什么
- **Preference Memory**：记录用户通常怎么做

### C. 召回确认升级

memory 召回不再默认静默生效。

系统在进入执行前，应先把拟召回内容整理成**可判断的摘要卡（Recall Review Card）**，由用户确认：

- 本次是否采用这些记忆
- 哪些记忆应保留、忽略或替换
- 是否对后续同类场景默认不再确认

---

## 4. 产品原则

### P1. 主动性必须可执行，而不只是可读

如果系统判断某个任务现在值得继续，产品的目标不是“提示用户自己去输入命令”，而是“给出提案，确认后立刻推进”。

### P2. Memory 必须帮助判断，而不是制造黑箱

系统在执行前可以召回 memory，但不能把召回内容直接静默注入后自动运行。  
召回内容必须先转成用户能快速判断的摘要，而不是原始数据 dump。

### P3. 用户确认的是“决策摘要”，不是数据库记录

用户不需要看到所有原始 snapshot、interaction、embedding candidate。  
用户需要看到的是：

- 这次系统想沿用什么
- 这些内容来自哪里
- 为什么它们和当前任务相关
- 如果采用，会影响什么

### P4. 记忆分层，策略分离

Task Memory 与 Preference Memory 都属于 memory，但二者的：

- 数据对象
- 生命周期
- 召回逻辑
- 用户确认方式

必须分别设计，不能混成一套逻辑。

### P5. 默认保守，允许用户逐步放权

V2 默认策略是：

- 系统可以主动提出执行提案
- 系统可以主动召回记忆
- 但执行前需要用户确认

之后用户可以在特定条件下选择：

- 同类 recall 以后不再确认
- 某类主动提案允许自动执行

---

## 5. Memory 边界定义

### 5.1 Working Memory

短期、即时上下文，不进入长期记忆库。

包括：

- 当前输入
- 当前对话焦点
- 当前运行中的临时指令
- 本次单次确认状态

### 5.2 Task Memory

回答问题：

- 这件具体工作之前做到哪了
- 为什么停下
- 做过哪些中间结论
- 有哪些相关材料和产物
- 有没有做过相似任务可复用

包括：

- task object
- snapshots
- interactions
- material summary
- task artifacts
- task relations
- recovery reasons

### 5.3 Preference Memory

回答问题：

- 用户通常怎么做
- 给某联系人输出时应采用什么风格
- 某项目应遵循什么术语和结构
- 某类任务通常用什么 workflow

包括：

- global preferences
- project preferences
- contact preferences
- task-local preferences

### 5.4 Recall 边界

V2 的 recall 不再等于“把所有命中项直接注入”。

召回过程分三步：

1. **候选生成**：规则召回 + embedding 召回
2. **摘要整理**：转成用户可判断的 recall review card
3. **用户确认**：确认后才进入执行上下文

---

## 6. 主动性产品设计

### 6.1 从 Suggestion 升级为 Proposal

V2 不再只产生 suggestion，而是产生结构化 proposal。

每个 proposal 至少包含：

- `trigger`
- `taskId`
- `actionType`
- `recommendedAction`
- `reasons[]`
- `confidence`
- `requiresConfirmation`
- `proposalPayload`
- `expiresAt`

### 6.2 第一批 proposal 类型

- `resume_task`
- `unblock_and_resume`
- `continue_followup`
- `prioritize_task`
- `resume_similar_task`
- `review_generated_artifact`

### 6.3 触发时机

- 启动时盘面建议
- 空闲提醒
- 任务完成后
- 阻塞解除后
- 被高优任务抢占后
- 新材料挂载后
- 长时间搁置后
- 命中高相关历史任务时

### 6.4 用户交互

示例：

```text
💡 建议恢复任务 #task_123：Phoenix 周报
→ 原因：材料已齐；上次下一步明确；刚被高优任务打断
→ 本次将同时参考 1 个相似历史任务、2 条项目偏好
→ 输入 y 立即执行，n 忽略，r 查看召回摘要
```

说明：

- `y`：接受 proposal，并进入 recall review
- `n`：忽略本次 proposal
- `r`：展开查看召回摘要卡

### 6.5 半自动推进

V2 采用“**系统主动提出，用户确认后自动推进**”的模式：

- 系统负责判断
- 用户负责最终授权
- 调度与执行自动完成

这比纯提醒更有行动力，也比完全自动执行更稳妥。

---

## 7. Memory Recall Review 设计

### 7.1 为什么需要 recall review

如果系统默认把命中的 task memory 和 preference memory 全部自动注入，有三个问题：

1. 召回结果可能不符合用户当前真实意图
2. 用户无法理解“系统为什么这么做”
3. 一旦 recall 错误，系统会带着错误上下文继续执行

因此，V2 需要在“召回”和“执行”之间增加一层用户可判断的 review。

### 7.2 Recall Review Card 的目标

Recall Review Card 不是原始数据列表，而是**决策摘要卡**。

它必须帮助用户快速回答：

- 这次系统准备沿用哪些内容
- 它们为什么相关
- 是否应该在本次执行中采用
- 以后类似情况是否可以默认采用

### 7.3 Recall Review Card 的内容结构

每次 review 按两个区域展示：

#### A. Task Memory Summary

内容形式不是原始 interactions，而是摘要：

- `上次做到`
- `建议续接点`
- `相似历史任务摘要`
- `可复用材料/产物`

示例：

```text
[任务记忆]
- 当前任务上次做到：风险栏目已整理，待补经营数据
- 建议续接点：直接补齐数据后生成终稿
- 找到 1 个相似任务：上周 Phoenix 周报，结构高度相似
- 可复用产物：/projects/phoenix-weekly-2026-04-12.md
```

#### B. Preference Memory Summary

内容形式不是原始 preference dump，而是用户可判断的工作约束摘要：

- `本次将沿用的工作方式`
- `联系人偏好`
- `项目术语/规范`
- `任务局部习惯`

示例：

```text
[偏好记忆]
- 本次将沿用：输出保留表格结构
- 项目术语：Phoenix 统一用 Phoenix 术语体系
- 联系人偏好：给张总的内容用正式语气
```

### 7.4 用户操作

Recall review 至少支持：

- `y`：本次采用全部摘要
- `n`：本次不采用 recall，直接按当前输入执行
- `e`：编辑后采用
- `s`：只采用其中一部分
- `a`：以后同类场景默认自动采用，不再确认

当前实现优先级：

- `y / n / s / a / r` 已落地
- `e` 仍保留在产品设计中，后续可扩展为“编辑摘要后的采用”

### 7.5 “以后不再确认”的授权粒度

用户不能只做一个全局粗暴开关。

V2 授权粒度应至少支持：

- 对某个 `taskId` 的 task memory recall 不再确认
- 对某个 `project` 的 preference recall 不再确认
- 对某个 `contact` 的 communication recall 不再确认
- 对某个 `proposalType` 的 recall review 不再确认

默认不提供“全局永不确认所有 recall”的一键开关。

### 7.6 自动模式的退出

即使用户授权未来默认采用，系统仍应允许：

- `/memory review-policy` 查看当前免确认策略
- `/memory review-policy revoke <id>` 撤销某条免确认授权

---

## 8. Embedding 语义检索设计

### 8.1 总体策略

embedding 与主动性独立设计。  
embedding 不负责决定“现在要不要执行”，只负责提升 recall 质量。

V2 采用混合方案：

- embedding 生成调用云端 API
- 向量持久化和召回逻辑保留在本地

### 8.2 Preference Memory 的 embedding 策略

第一阶段只覆盖：

- `confirmed preferences`

召回方式：

1. 规则召回：scope / subject / keyword
2. embedding 召回：semantic top-k
3. 合并去重
4. scope-aware rerank
5. 输出 recall review summary

### 8.3 Task Memory 的 embedding 策略

Task Memory 不从全量 interaction 生文本 embedding 起步。  
第一阶段先对**任务级摘要对象**做 embedding。

建议索引对象：

- task title
- task goal
- latest summary
- latest snapshot summary
- material summary

后续再扩展到：

- artifact summary
- snapshot chunk
- interaction chunk

### 8.4 Embedding 的角色

embedding 在 V2 主要承担三件事：

1. 找到和当前任务语义接近的历史任务
2. 找到和当前意图语义接近的长期偏好
3. 为主动 proposal 提供“相似任务可复用”的依据

### 8.5 Recall 解释要求

embedding 命中不能只输出“语义相似”。  
必须转成用户能理解的解释：

- 与当前任务目标相似
- 与当前联系人场景相似
- 与当前项目产出物结构相似

---

## 9. 技术架构

### 9.1 新的核心模块

- `TaskSignalService`
- `GuidancePolicyEngine`
- `GuidanceActionExecutor`
- `PreferenceEmbeddingService`
- `TaskEmbeddingService`
- `HybridMemoryRecaller`
- `RecallReviewBuilder`
- `RecallPolicyService`

### 9.2 模块职责

#### TaskSignalService

负责维护真实任务信号：

- `isReady`
- `progressRatio`
- `idleHours`
- `blocksOthers`
- `hasNewMaterials`
- `resumability`

#### GuidancePolicyEngine

输入：

- 任务状态
- 任务信号
- task memory recall
- preference memory recall

输出：

- `GuidanceProposal[]`

#### GuidanceActionExecutor

当用户接受 proposal 后：

- 构建 recall review
- 处理用户确认
- 转为真实调度动作

#### PreferenceEmbeddingService

负责：

- confirmed preference embedding 生成
- 更新时重建 embedding
- backfill

#### TaskEmbeddingService

负责：

- task summary embedding
- snapshot summary embedding
- artifact summary embedding

#### HybridMemoryRecaller

统一完成：

- 规则召回
- embedding 召回
- merge / dedupe / rerank
- 输出 recall candidate

#### RecallReviewBuilder

将 recall candidate 变成摘要卡，而不是原始数据结构。

#### RecallPolicyService

管理：

- 本次是否确认
- 某类 recall 是否免确认
- 用户未来授权策略

---

## 10. 数据模型

### 10.1 guidance_events

记录主动提案的生命周期：

- `id`
- `trigger`
- `task_id`
- `action_type`
- `payload_json`
- `reasons_json`
- `confidence`
- `requires_confirmation`
- `accepted_at`
- `dismissed_at`
- `executed_at`
- `created_at`

### 10.2 task_relations

记录任务之间的关系：

- `id`
- `source_task_id`
- `target_task_id`
- `relation_type`
- `created_at`

关系类型至少包括：

- `follow_up`
- `similar_to`
- `derived_from`

### 10.3 task_memory_embeddings

- `id`
- `task_id`
- `memory_kind`
- `source_id`
- `provider`
- `model`
- `dimension`
- `vector_json`
- `content_hash`
- `created_at`
- `updated_at`

### 10.4 preference_embeddings

- `id`
- `preference_id`
- `provider`
- `model`
- `dimension`
- `vector_json`
- `content_hash`
- `created_at`
- `updated_at`

### 10.5 memory_recall_events

记录每次 recall 的候选与结果：

- `id`
- `task_id`
- `query_text`
- `query_hash`
- `task_candidates_json`
- `preference_candidates_json`
- `review_summary_json`
- `accepted_candidates_json`
- `created_at`

### 10.6 recall_review_policies

记录用户对“未来是否免确认”的授权：

- `id`
- `policy_type`
- `scope`
- `subject`
- `proposal_type`
- `auto_apply`
- `created_at`
- `updated_at`

---

## 11. 核心流程

### 11.1 主动 proposal 流程

1. `TaskSignalService` 更新信号
2. `GuidancePolicyEngine` 产出 proposal
3. TUI 展示 proposal
4. 用户确认 proposal
5. 系统构建 recall review
6. 用户确认 recall review
7. `GuidanceActionExecutor` 执行调度
8. 写入 `guidance_events`

### 11.2 Memory recall 流程

1. 构建 query
2. 规则召回 task memory / preference memory
3. embedding 召回 task memory / preference memory
4. merge + rerank
5. `RecallReviewBuilder` 转成摘要卡
6. 用户确认
7. accepted items 才进入 `ExecutionContextBundle`
8. 写入 `memory_recall_events`

### 11.3 用户授权未来免确认流程

1. 用户在 recall review 中选择 `a`
2. `RecallPolicyService` 写入 policy
3. 后续命中同类条件时跳过 review
4. 系统仍在 transcript 中说明“本次按你的授权自动采用了 X 类 recall”

---

## 12. 默认交互策略

### 默认

- proposal 需要用户确认
- recall review 需要用户确认
- 执行不默认静默进行

### 允许用户放权

用户可对以下对象逐步放权：

- 某联系人沟通类 preference recall
- 某项目规范类 preference recall
- 某任务恢复类 task memory recall
- 某类主动 proposal

### 不允许一步到位放权

V2 不支持：

- 全局关闭所有 recall review
- 所有 proposal 永久自动执行

原因：这会迅速把系统从“可信的管家”变成“黑箱自动机”。

---

## 13. 实施顺序

### Phase 1：主动性可执行化

- 引入 `GuidanceProposal`
- proposal 确认后自动推进
- `guidance_events`
- 启动、空闲、完成后、解除阻塞后 4 个 trigger 跑通

### Phase 2：Recall Review 上线

- 引入 `RecallReviewBuilder`
- 召回摘要卡
- 用户确认后才注入
- `recall_review_policies`

### Phase 3：Preference Memory embedding

- 云端 embedding provider
- `preference_embeddings`
- hybrid preference recall
- recall 审计

### Phase 4：Task Memory embedding

- `task_relations`
- `task_memory_embeddings`
- 相似任务召回
- `resume_similar_task` proposal

---

## 14. 验收标准

### 主动性

- 系统建议必须可确认执行
- 用户确认后系统直接推进，不要求重复输入命令
- 建议必须附带可理解的原因
- 至少覆盖启动、空闲、完成后、解除阻塞后、抢占回补

### Memory

- memory 拆分为 task memory 与 preference memory
- recall 不默认静默生效
- recall 在执行前必须转成摘要卡并由用户确认
- 用户可以对特定场景授权未来免确认
- embedding 服务失败时不影响主流程，自动回退规则召回

### 产品质感

- 用户面对的是“判断摘要”，不是原始 recall 数据
- 用户知道系统准备沿用什么、为什么、影响什么
- 用户确认后能感受到系统真正“接住并推进了工作”

---

## 15. 最终总结

V2 的关键不是再加几个 reminder，也不是单纯给 memory 接一个 embedding API。

V2 要完成的是三个升级：

1. **主动性从文本建议升级为可执行提案**
2. **memory 从单一偏好库升级为双层 memory**
3. **召回从静默注入升级为“摘要卡 + 用户确认 + 可逐步放权”**

如果 V1 证明的是：

> Metaclaw 能接住任务、记住偏好、恢复工作

那么 V2 要证明的是：

> Metaclaw 能在理解任务连续性和长期工作方式的前提下，主动提出下一步，并在用户授权后稳妥地推进工作。
