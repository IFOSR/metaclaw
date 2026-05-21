# MetaClaw 最终优化方案：Codex 记忆自动化 + 工作图谱 + Skill 进化 + Executor 路由

> 日期：2026-05-20  
> 状态：最终方案文档 / 待分阶段 TDD 实施  
> 输入文档：`docs/codex-memory-analysis-and-metaclaw-automation.md`、`docs/metaclaw-optimization-plan-memory-routing-skill-feedback.md`  
> 核心收敛：借鉴 Codex 的静默自动化心态，保留 MetaClaw 的本地可追溯、工作图谱、Skill 进化和 Executor 路由优势。

## 1. 最终结论

MetaClaw 的方向不是做一个更复杂的“记忆管理系统”，而是成为：

> 默认静默、自动判断、事后可审计的 Task Memory OS。

最终形态：

```text
用户输入
  ↓
Intent Understanding
  ↓
Memory Auto Capture
  ↓
Memory Applicability Judge
  ↓
auto_apply / ask_review / suppress
  ↓
Profile + Timeline + Relation + Evidence
  ↓
Executor Router
  ↓
Executor 执行
  ↓
Skill Runtime Feedback
  ↓
Skill Patch Candidate
  ↓
Markdown / Obsidian Vault
```

MetaClaw 应吸收 Codex 的自动化心态：

- 普通记忆写入应自动完成。
- 高相关记忆召回应自动采用。
- 用户不应被频繁确认打断。
- `/memory` 应是事后管理入口，而不是每次工作前的必经流程。

同时，MetaClaw 不能复制 Codex 的黑盒服务端记忆模式。MetaClaw 的差异化是：

- 本地优先。
- Evidence 可追溯。
- Timeline 可回看。
- Vault 可导出。
- Skill 可持续演进。
- Executor 可按任务路由。

## 2. 最终产品原则

### P1. 静默是默认，确认是例外

普通偏好写入、召回、采用都应尽量静默完成。只有不确定、高风险、冲突、外部副作用明显时才请求用户确认。

### P2. LLM 是主判断器，规则只是 fallback

关键词、scope、subject、阈值只能生成候选，不能直接决定召回、采用或打扰用户。记忆是否适用，应优先由 LLM 基于语义意图判断。

### P3. 低风险全自动，高风险强审计

输出风格、代码偏好、文档结构、常用命令等低风险记忆可以自动写入和自动采用。外发、删除、生产环境、法律/财务承诺等高风险动作必须保留确认。

### P4. 自然语言记忆优先，结构化元数据辅助

Codex 的优势是自然语言记忆容易被 LLM 理解。MetaClaw 应保留 SQLite 字段和 Markdown frontmatter，但记忆正文必须是自然语言资产。

### P5. 所有静默自动化都必须可追溯

自动写入、自动采用、自动忽略、自动 patch 候选都必须留下 evidence、timeline event 和可解释 reason。

### P6. 不把知识管理层塞进 MetaClaw

AutoFetch、多源知识摄取、外部知识库同步应属于知识管理层。MetaClaw 可以消费这些材料和索引，但不直接承担所有信息源摄取。

## 3. 当前核心问题

### 3.1 用户参与节点太多

当前 MetaClaw 的交互链路中，用户可能被多个节点打断：

```text
用户输入任务
   ↓
操作提案确认
   ↓
记忆召回确认
   ↓
任务执行
   ↓
偏好候选确认
   ↓
学习候选审核
```

其中，记忆召回确认和偏好候选确认是最主要的摩擦来源。

### 3.2 关键词召回不等于意图匹配

历史长期偏好只要命中关键词，就可能进入 recall review。这会导致：

- 无关记忆反复打扰用户。
- 全局偏好污染无关任务。
- 用户在讨论系统机制时也被业务记忆打断。
- 高相关偏好反而需要重复确认。

### 3.3 三次阈值已经不适合作为主路径

三次阈值适合早期保守设计，但现在明显增加了用户负担。Codex 的实践说明，LLM 可以在一次对话中判断“这是不是值得记住的长期偏好”。

### 3.4 静默自动化缺少审计层会变成黑盒

如果 MetaClaw 直接复制 Codex 的静默记忆模式，用户会失去对本地长期记忆的控制感。因此，静默自动化必须配套 Evidence、Timeline、Vault 和 explain 命令。

## 4. 主线一：记忆写入自动化

### 4.1 目标

从：

```text
重复出现 3 次 → 弹确认 → 写入偏好
```

改为：

```text
用户输入
  ↓
LLM 判断是否值得长期记住
  ↓
低风险高置信 → 自动写入
  ↓
中置信 → silent candidate
  ↓
高风险 → 请求确认或拒绝写入
```

### 4.2 写入策略

| 场景 | 行为 |
| --- | --- |
| 用户明确说“记住、以后、默认、不要再” | 低风险时直接写入长期记忆 |
| LLM 高置信识别长期偏好 | 直接写入，生成 evidence |
| LLM 中置信 | 生成 silent candidate，不打断 |
| 敏感信息或高风险偏好 | 请求确认或拒绝写入 |
| LLM 不可用 | 回退到三次阈值 |

三次阈值不再是主路径，只作为 fallback。

### 4.3 用户体验

默认轻提示或静默：

```text
→ 已记录偏好：复杂方案默认先给结论，再列执行细节。
```

也可以只在任务详情或 `/memory recent` 中显示，不打断主流程。

### 4.4 新增能力

```text
/memory recent
/memory auto-captured
/memory undo <id>
```

### 4.5 约束

- 自动写入必须有 evidence。
- 自动写入必须有可撤销入口。
- 高风险内容不能静默写入。
- 推断型记忆必须标注 confidence。

## 5. 主线二：记忆召回三态决策

### 5.1 目标

从：

```text
候选召回成功 → 进入记忆召回确认
```

改为：

```text
候选召回成功
  ↓
Intent Gate
  ↓
Applicability Judge
  ↓
auto_apply / ask_review / suppress
```

### 5.2 三态动作

| 动作 | 含义 | 用户感知 |
| --- | --- | --- |
| `auto_apply` | 明确相关、低风险、直接采用 | 默认不弹确认 |
| `ask_review` | 不确定、冲突或高影响 | 弹 recall review |
| `suppress` | 不相关、泛词命中、反场景 | 完全静默 |

### 5.3 自动采用条件

- 当前意图明确需要该记忆参与。
- 语义高相关，而不是关键词相同。
- 作用域匹配当前任务、项目、联系人或输出类型。
- 风险低。
- 无更近用户指令冲突。
- 不是泛词命中。

示例：

```text
偏好：复杂方案先给结论，再列细节。
当前请求：详细列一个 MetaClaw 优化方案。
动作：auto_apply。
```

### 5.4 需要确认的条件

- 中等相关，系统不确定是否适用。
- 多条记忆互相冲突。
- 记忆会明显改变执行路径或输出结构。
- 项目、联系人、对象不确定。
- 记忆较旧，且当前语义只是部分相关。
- 涉及外发、生产、删除、法律/财务承诺等高风险动作。

### 5.5 静默忽略条件

- 只有关键词相同。
- 当前输入是系统机制咨询。
- 当前输入是纠错、否认或覆盖旧规则。
- 当前输入是元讨论。
- 全局偏好只有弱相关。
- embedding 排进 topK 但分数低。
- LLM judge 失败后只能命中宽松规则。

### 5.6 评分模型

```text
finalScore =
  semanticSimilarity
  + scopeBoost
  + intentMatchBoost
  + subjectMatchBoost
  + recentPositiveFeedbackBoost
  - genericKeywordPenalty
  - negativeCuePenalty
  - oldRejectedPenalty
  - conflictPenalty
```

建议阈值：

| 分数 | 动作 |
| --- | --- |
| `>= 0.82` | `auto_apply` |
| `0.55 - 0.82` | `ask_review` |
| `< 0.55` | `suppress` |

不同 scope 的建议阈值：

| Scope | 自动采用门槛 | 确认门槛 |
| --- | --- | --- |
| `task-local` | 0.72 | 0.45 |
| `project` | 0.80 | 0.55 |
| `contact` | 0.82 | 0.58 |
| `global` | 0.88 | 0.65 |

## 6. 主线三：静默日志与事后审计

### 6.1 目标

自动采用的记忆不弹窗，但必须可审计、可解释、可撤销。

### 6.2 任务详情展示

```text
已自动采用记忆
- pref_xxx：复杂方案先给结论再列细节，score=0.91
- pref_yyy：MetaClaw 文档使用中文，score=0.88
```

### 6.3 命令

```text
/memory applied
/memory applied <taskId>
/memory explain <memoryId>
/memory undo <memoryId>
```

### 6.4 审计记录

每次自动采用都记录：

- taskId。
- memoryId。
- action。
- score。
- reason。
- judge source。
- evidenceIds。
- createdAt。

## 7. 主线四：自然语言记忆 + 结构化元数据

### 7.1 目标

结合 Codex 与 MetaClaw 的优势：

- Codex：自然语言记忆更容易被 LLM 理解。
- MetaClaw：结构化元数据更适合本地审计、过滤和迁移。

### 7.2 存储原则

| 层 | 作用 |
| --- | --- |
| 自然语言正文 | 给 LLM 理解、召回、推理 |
| frontmatter | 给系统过滤、审计、同步 |
| SQLite | 给运行时查询、排序、事务 |
| Vault | 给用户查看、迁移、编辑 |

### 7.3 示例

```md
---
id: pref_xxx
kind: preference
scope: project
subject: MetaClaw
confidence: 0.92
risk: low
evidence:
  - evidence_123
relations:
  - used_by: task_abc
---

# 复杂方案输出偏好

用户偏好复杂方案先给结论，再列关键决策、执行步骤和验收标准。
```

### 7.4 召回原则

自然语言相似度优先，结构化字段辅助过滤。字段匹配不能替代语义判断。

## 8. 主线五：Profile + Timeline + Relation + Evidence 工作图谱

### 8.1 目标

借鉴 OpenHuman 的长期上下文和可追溯图谱能力，但不做数字人或人格化。MetaClaw 的图谱对象是：

- 工作状态。
- 项目状态。
- 任务决策。
- 用户偏好。
- 执行器能力。
- Skill 演化。

### 8.2 四类核心资产

| 资产 | 用途 |
| --- | --- |
| Profile | 用户、项目、联系人、Executor 的长期工作画像 |
| Timeline | 记录偏好变化、项目决策、任务完成、Skill patch |
| Relation | 连接任务、记忆、证据、产物、Skill、Executor |
| Evidence | 证明这条记忆从哪里来、为什么存在 |

### 8.3 自动生成流程

```text
MetaClaw 静默写入记忆
  ↓
自动生成 Evidence
  ↓
自动挂到 Profile
  ↓
自动生成 Timeline event
  ↓
自动建立 Relation
  ↓
用户事后可查看
```

### 8.4 Evidence 规则

- 所有长期记忆必须有 evidence。
- 低风险显式偏好可以自动写入，但仍必须保存 evidence。
- 推断型记忆必须标注 confidence。
- 无 evidence 的内容不得进入高权威召回。

### 8.5 命令

```text
/memory explain <id>
/memory timeline
/memory timeline project <name>
/memory relations <id>
/memory evidence <id>
/profile user
/profile project <name>
/profile executor <name>
```

## 9. 主线六：Markdown / Obsidian Memory Vault

### 9.1 目标

让 MetaClaw 的长期记忆不只是 SQLite 中的运行时数据，而是用户可读、可搜索、可迁移、可审阅的本地资产。

### 9.2 目录结构

```text
~/.metaclaw/vault/
  README.md
  preferences/
  profiles/
    user.md
    projects/
    contacts/
    executors/
  tasks/
  decisions/
  evidence/
  skills/
  timelines/
```

### 9.3 同步策略

第一版只做单向导出：

```text
SQLite → Markdown Vault
```

命令：

```text
/memory vault export
/memory vault status
```

第二版再做双向同步：

```text
Markdown Vault → SQLite
```

命令：

```text
/memory vault sync
/memory vault diff
```

### 9.4 冲突策略

- SQLite 是运行时权威存储。
- Vault 是用户可读资产层。
- 用户手动编辑 Markdown 后，同步必须显示 diff。
- 不允许静默覆盖数据库记忆。
- 发生冲突时创建 conflict note。

## 10. 主线七：Skill 使用中反馈与自动 Patch

### 10.1 目标

借鉴 Hermes Agent 的使用中改进机制，让 MetaClaw 不仅能 promotion Skill，还能在 Skill 使用过程中发现问题并生成 patch 候选。

### 10.2 闭环流程

```text
Executor 使用 Skill
  ↓
MetaClaw 收集使用结果、失败、用户纠正、重复补救动作
  ↓
生成 SkillRuntimeFeedback
  ↓
聚合成 SkillPatchCandidate
  ↓
安全扫描
  ↓
用户审核或低风险建议
  ↓
promotion 到 Executor
```

### 10.3 采集信号

- Executor 明确上报 skill failed。
- Executor 没按 Skill 要求执行。
- 用户纠正 Skill 输出。
- 同类任务重复出现相同失败。
- 执行器手动绕过原 Skill。
- 测试失败后补了一步固定操作。
- 高频使用 Skill 但耗时或失败率异常。
- 用户说“以后这个 Skill 要先做 X”。

### 10.4 第一版策略

第一版不自动改 Skill，只生成 patch candidate。

命令：

```text
/learning skill-feedback
/learning patch candidates
/learning patch approve <id>
/learning patch promote <id>
```

### 10.5 审计约束

- Skill patch 必须关联 feedback。
- Skill patch 必须关联 evidence。
- Skill patch 生成 timeline event。
- Skill patch 与失败任务、用户纠正、Executor、Skill 建立 relation。
- 低风险建议也不能绕过 SafetyScanner 和 PromotionGate。

## 11. 主线八：Executor 路由层

### 11.1 目标

MetaClaw 要成为上层大脑，根据任务意图、行业领域、输入材料、输出要求、风险等级、执行器能力和历史效果，把任务交给最合适的 Executor。

### 11.2 路由流程

```text
Task Understanding
  ↓
Executor Registry
  ↓
Executor Router
  ↓
Route Decision
  ↓
Dispatch
  ↓
Route Feedback
```

### 11.3 Executor 能力画像

每个 Executor 需要维护：

- domains。
- capabilities。
- inputTypes。
- outputTypes。
- strengths。
- weaknesses。
- riskLevel。
- availability。
- historicalSuccess。

### 11.4 路由原则

| 置信度 | 行为 |
| --- | --- |
| 高置信 | 自动派发 |
| 中置信 | 询问用户 |
| 低置信 | fallback 到默认 executor |
| 高风险 | 要求确认 |
| 用户显式指定 | 尊重用户 |

示例：

```text
→ 已派发给 legal-contract：检测到合同条款审查任务，目标是风险矩阵。
```

### 11.5 路由反馈

每次路由都要记录：

- task understanding。
- 候选 executor 分数。
- 最终选择。
- 是否用户确认。
- 执行结果。
- 用户是否手动改派。

后续用于更新 executor 权重和能力画像。

## 12. 最终实施优先级

| 优先级 | 阶段 | 目标 |
| --- | --- | --- |
| P0 | 记忆召回三态决策 | 解决当前最大干扰源 |
| P1 | LLM 自动写入记忆 | 去掉三次阈值主路径 |
| P2 | 静默日志与事后审计 | auto_apply 不打断但可解释 |
| P3 | Evidence + Timeline | 所有自动记忆都有来源 |
| P4 | Profile + Relation | 从偏好列表升级为工作图谱 |
| P5 | Markdown / Obsidian Vault | 记忆变成用户本地资产 |
| P6 | Skill Runtime Feedback | 收集 Skill 使用中问题 |
| P7 | Skill Patch Loop | 自动生成 patch 候选 |
| P8 | Executor Registry | 多 Executor 能力画像 |
| P9 | Executor Router | 根据任务自动选择 Executor |

## 13. 实施约束

- 不一次性大改架构。
- 不绕过已有 TaskEngine、SchedulerEngine、RecallReview、ExecutorAdapter、Phase E 管道。
- 不复制 Codex 的云端记忆架构。
- 不做 Project 级云端隔离和跨设备同步。
- 不把 AutoFetch 放进 MetaClaw 核心。
- 所有自动采用都必须可审计、可撤销。
- 所有长期记忆都必须有 evidence。
- 高风险动作不能因为记忆匹配而自动执行。
- Vault 第一版只做单向导出。
- Skill patch 第一版只生成候选，不自动修改执行器技能。
- Executor router 第一版必须保留默认 executor fallback。

## 14. 最终验收指标

| 指标 | 目标 |
| --- | --- |
| Recall review 弹出率 | 下降 70% 以上 |
| 无关 recall review 比例 | 低于 20% |
| 高相关偏好自动采用率 | 高于 60% |
| 明确长期偏好写入 | 不再依赖三次阈值 |
| auto_apply 可审计率 | 100% |
| 长期记忆 evidence 覆盖率 | 100% |
| Vault 导出覆盖 | Preference、Task Card、Evidence、Profile、Skill |
| Skill patch candidate | 必须关联 feedback 和 evidence |
| Executor route event | 覆盖 100% 派发任务 |

## 15. 最终一句话方案

MetaClaw 最终应借鉴 Codex 的“静默自动化”和 LLM 判断能力，借鉴 OpenHuman 的“可追溯工作图谱”，借鉴 Hermes 的“Skill 使用中进化”，最终形成一个本地优先、低打扰、可审计、可路由、可自我改进的 Task Memory OS。

