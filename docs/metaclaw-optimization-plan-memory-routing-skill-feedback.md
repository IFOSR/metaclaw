# MetaClaw 优化方案：精准记忆、工作图谱、Vault、Skill 反馈与 Executor 路由

> 日期：2026-05-18  
> 状态：方案文档 / 待分阶段 TDD 实施  
> 范围：聚焦记忆召回降噪、可追溯工作图谱、本地 Markdown/Obsidian Vault、Skill 使用中改进闭环、Executor 路由层。  
> 明确不做：安装包优化、AutoFetch/知识管理摄取层、重型工程可靠性改造、人格化数字人。

## 1. 结论

MetaClaw 下一阶段不应追求“记得更多”，而应追求：

```text
正确理解当前任务
  ↓
只召回真正相关的记忆
  ↓
用 Profile / Timeline / Relation / Evidence 解释上下文
  ↓
把任务派给最合适的 Executor
  ↓
执行中收集 Skill feedback
  ↓
把经验沉淀成可审核、可追溯、可导出的长期资产
```

核心目标：

1. **减少记忆干扰**：从“命中就确认”升级为 `auto_apply / ask_review / suppress` 三态决策。
2. **让记忆可追溯**：从 Preference / Task Card 扩展到 Profile + Timeline + Relation + Evidence。
3. **让记忆成为用户资产**：同步到本地 Markdown / Obsidian Vault，可读、可搜、可迁移。
4. **让执行能力持续进化**：借鉴 Hermes Agent 的使用中反馈机制，自动生成 Skill patch 候选。
5. **让 MetaClaw 成为上层大脑**：根据任务意图、行业领域、执行器能力和历史效果路由到合适 Executor。

## 2. 范围边界

### 2.1 本轮要做

- 记忆召回精准度治理。
- 高相关长期偏好自动采用。
- 不相关记忆静默忽略。
- 只有不确定或高影响记忆才请求用户确认。
- Profile / Timeline / Relation / Evidence 数据层。
- 本地 Markdown / Obsidian memory vault。
- Skill runtime feedback 采集。
- Skill patch candidate 自动生成与 promotion 闭环。
- Executor registry 与 router。

### 2.2 本轮不做

- 安装包和分发体验优化。
- AutoFetch、多源知识摄取、外部知识管理连接器。
- 大规模工程可靠性改造。
- 人格化、数字人、mascot、声线/形象克隆。
- 全量历史 interaction embedding。
- 所有记忆默认确认。

AutoFetch 应属于知识管理层，而不是 MetaClaw 核心。MetaClaw 可以消费知识管理层输出的材料、索引或摘要，但不直接承担所有信息源摄取。

## 3. 当前问题

### 3.1 记忆召回过度打扰

当前 MetaClaw 已有 Preference Memory、Task Memory Card、Hybrid Recall、Recall Review、Recall Feedback、Review Policy 等基础，但实践中出现明显噪声：

- 关键词命中被误认为意图匹配。
- 全局偏好容易污染无关任务。
- 用户在问系统行为、机制、纠错、临时问题时，也可能被业务偏好打断。
- 高相关长期偏好仍反复让用户确认。
- LLM judge 不可用时 fallback 到规则/关键词召回，容易放大噪声。

问题不在 recall review 本身，而在 review 触发太早、太粗。候选生成不应等于用户确认。

### 3.2 记忆资产不够可解释

当前长期记忆更多表现为偏好条目或任务卡。用户很难回答：

- 这条记忆从哪里来？
- 是哪次任务、哪句话、哪个执行结果形成的？
- 它适用于哪些场景？
- 什么时候被使用过？
- 有没有被后来的指令覆盖？
- 为什么这次会召回它？

### 3.3 记忆仍是数据库资产，不是用户资产

SQLite 适合系统运行，但不适合用户长期审阅、搜索、迁移和建立信任。用户需要可读的本地记忆仓库。

### 3.4 Skill promotion 有基础，但缺使用中改进闭环

Phase E 已有学习候选、Skill promotion、Skill patch、Skill governance、Skill usage event 等基础，但还缺少更完整的闭环：

```text
Executor 使用 Skill
  ↓
运行中暴露问题
  ↓
MetaClaw 识别可改进点
  ↓
生成 Skill patch 候选
  ↓
审核 / 安全扫描 / promotion
  ↓
Executor 更新 Skill
  ↓
后续验证 patch 是否有效
```

### 3.5 Executor 选择过于单一

当前 MetaClaw 更接近单执行器调度。随着行业深入，不同垂类会出现不同 Executor。MetaClaw 应作为上层大脑，决定任务交给谁，而不是固定把所有任务交给默认执行器。

## 4. 主线一：记忆召回三态决策

### 4.1 目标

从：

```text
候选召回成功 → 进入记忆召回确认
```

改为：

```text
候选召回成功
  ↓
判断当前意图是否需要长期记忆
  ↓
判断每条候选是否适用
  ↓
auto_apply / ask_review / suppress
```

### 4.2 三态动作

| 动作 | 含义 | 用户感知 |
| --- | --- | --- |
| `auto_apply` | 语义明确相关，低风险，直接采用 | 默认不弹确认，可在任务详情中展示 |
| `ask_review` | 可能相关，但系统拿不准或影响较大 | 弹 recall review |
| `suppress` | 不相关、弱相关、泛词命中或反场景 | 完全静默 |

### 4.3 自动采用条件

满足以下条件时自动采用：

- 当前意图明确需要该偏好参与。
- 偏好作用域匹配当前任务、项目、联系人或输出类型。
- 语义相关度高，例如 `score >= 0.82`。
- 风险低，不涉及外发、删除、支付、生产环境、隐私敏感推断。
- 无更近用户指令冲突。
- 不是泛词命中。

示例：

```text
偏好：复杂方案先给结论，再列细节。
当前请求：详细列一个 MetaClaw 优化方案。
动作：auto_apply。
```

### 4.4 需要确认的条件

只有以下场景进入 recall review：

- 中等相关，系统不确定是否适用。
- 多条偏好互相冲突。
- 偏好会明显改变执行路径、输出结构或对外承诺。
- 项目、联系人、对象不确定。
- 记忆较旧，且当前语义只是部分相关。
- 涉及高风险动作。

### 4.5 静默忽略条件

以下场景直接 suppress：

- 只有关键词相同。
- 当前输入是系统机制咨询。
- 当前输入是纠错、否认或覆盖旧规则。
- 当前输入是元讨论。
- 全局偏好只有弱相关。
- embedding 排进 topK 但分数低。
- LLM judge 失败后只能命中宽松规则。

### 4.6 召回评分

每条候选不再只看关键词或 embedding，而使用综合评分：

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

不同作用域应有不同阈值：

| Scope | 自动采用门槛 | 确认门槛 |
| --- | --- | --- |
| `task-local` | 0.72 | 0.45 |
| `project` | 0.80 | 0.55 |
| `contact` | 0.82 | 0.58 |
| `global` | 0.88 | 0.65 |

全局偏好污染面最大，所以阈值最高。

### 4.7 新增类型

```ts
type RecallAction = 'auto_apply' | 'ask_review' | 'suppress';

interface MemoryApplicabilityDecision {
  candidateId: string;
  action: RecallAction;
  score: number;
  reason: string;
  risk: 'low' | 'medium' | 'high';
}

interface PreferenceApplicability {
  preferenceId: string;
  appliesToIntents: string[];
  appliesToDomains: string[];
  appliesToOutputTypes: string[];
  negativeCues: string[];
  riskLevel: 'low' | 'medium' | 'high';
  autoApplyThreshold: number;
  reviewThreshold: number;
  lastAutoAppliedAt: string | null;
  lastRejectedAsIrrelevantAt: string | null;
}
```

### 4.8 实现模块

建议新增：

```text
src/core/memory-applicability-judge.ts
src/core/memory-recall-policy.ts
tests/core/memory-applicability-judge.test.ts
tests/core/memory-recall-policy.test.ts
```

改造：

- `MemoryEngine.recallForReview` 不再只返回“要确认的候选”，而返回候选与 applicability decision。
- `MetaclawSession.prepareTaskExecution` 按三态动作拆分候选。
- LLM bridge 的 preference recall judge 输出 `action / score / risk / reason`。
- fallback 策略改为保守：LLM 不可用时，不允许 global keyword recall 直接打扰用户。

### 4.9 验收标准

- Recall review 弹出率降低 70% 以上。
- 用户拒绝/标记不相关比例降到 20% 以下。
- 高相关偏好自动采用率提升到 60% 以上。
- 泛词关键词误召回归零。
- 当前任务局部记忆命中率不下降。
- 用户 hide 后，同类输入不再召回同一记忆。

测试场景：

- 全局“正式语气”不干扰代码任务。
- 全局“先结论后依据”自动用于方案类任务。
- 联系人“张总正式语气”只在沟通张总时采用。
- 用户问 MetaClaw 记忆机制时不召回业务偏好。
- LLM judge 失败时不弹全局关键词召回。
- 用户 hide 后同类输入不再召回。
- 冲突偏好进入确认卡而不是自动采用。
- 当前 task-local 偏好可自动采用。

## 5. 主线二：Profile + Timeline + Relation + Evidence 工作图谱

### 5.1 目标

借鉴 OpenHuman 的长期上下文和可追溯图谱能力，但不复制人格化路线。MetaClaw 的对象不是数字人，而是工作状态、项目状态、任务决策、用户偏好、执行器能力和 Skill 演化。

目标是从：

```text
Preference / Task Card
```

扩展为：

```text
Profile + Timeline + Relation + Evidence
```

### 5.2 资产定义

| 资产 | 回答的问题 |
| --- | --- |
| Profile | 用户、项目、联系人、Executor 的长期画像是什么 |
| Timeline | 什么时候发生了偏好变化、项目决策、任务完成、Skill patch |
| Relation | 任务、记忆、决策、证据、产物、Skill 之间是什么关系 |
| Evidence | 每条记忆或决策的来源证据是什么 |

### 5.3 Profile

Profile 不做人格化，而做工作画像。

```ts
interface MemoryProfile {
  id: string;
  profileType: 'user' | 'project' | 'contact' | 'executor';
  subject: string;
  summary: string;
  facts: Array<{
    key: string;
    value: string;
    confidence: number;
    evidenceIds: string[];
  }>;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}
```

示例：

```text
ProjectProfile: MetaClaw
- 定位：任务连续性、偏好记忆与主动编排中枢。
- 当前重点：记忆召回降噪、工作图谱、Executor 路由。
- 不做：安装包、AutoFetch、人格化。
```

### 5.4 Timeline

```ts
interface MemoryTimelineEvent {
  id: string;
  eventType:
    | 'preference_created'
    | 'preference_updated'
    | 'project_decision'
    | 'task_completed'
    | 'skill_used'
    | 'skill_patch_suggested'
    | 'executor_routed'
    | 'user_correction';
  subjectKind: 'user' | 'project' | 'task' | 'preference' | 'skill' | 'executor' | 'artifact';
  subjectId: string;
  summary: string;
  evidenceIds: string[];
  occurredAt: string;
}
```

用途：

- 解释偏好何时形成。
- 判断旧偏好是否被新指令覆盖。
- 生成项目状态报告。
- 为召回排序提供时间和演化信号。

### 5.5 Relation

```ts
interface MemoryRelation {
  id: string;
  fromKind: string;
  fromId: string;
  relation:
    | 'supports'
    | 'derived_from'
    | 'updates'
    | 'conflicts_with'
    | 'used_by'
    | 'belongs_to'
    | 'produced'
    | 'routed_to';
  toKind: string;
  toId: string;
  confidence: number;
  createdAt: string;
}
```

用途：

- 召回时按关系路径判断，而不是只按关键词。
- 查看某条偏好用在哪些任务。
- 查看某个 Skill patch 来源于哪些失败和纠正。
- 查看某个项目决策支持了哪些执行结果。

### 5.6 Evidence

```ts
interface MemoryEvidence {
  id: string;
  sourceType: 'user_message' | 'executor_output' | 'task_result' | 'manual' | 'feedback';
  sourceId: string;
  quote: string;
  confidence: number;
  createdAt: string;
}
```

规则：

- 所有长期记忆必须有 evidence。
- 低风险显式偏好可以自动写入，但仍必须保存 evidence。
- 推断型记忆必须标注 confidence。
- 无 evidence 的内容不得进入高权威召回。

### 5.7 用户命令

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

## 6. 主线三：本地 Markdown / Obsidian Memory Vault

### 6.1 目标

让 MetaClaw 的长期记忆不只是 SQLite 中的运行时数据，而是用户可读、可搜索、可迁移、可审阅的本地资产。

### 6.2 目录结构

默认目录：

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

### 6.3 Markdown 格式

示例：

```md
---
id: pref_xxx
kind: preference
scope: project
subject: MetaClaw
status: active
confidence: 0.92
created_at: 2026-05-18T10:00:00Z
evidence:
  - evidence_123
relations:
  - updates: pref_old
  - used_by: task_abc
---

# 偏好：方案要先结论后细节

## 内容

用户偏好在复杂方案中先给结论，再列实现细节。

## 适用场景

- 架构方案
- 代码优化计划
- 产品规划

## 不适用场景

- 简短命令
- 闲聊
- 系统机制调试
```

### 6.4 同步策略

第一版采用单向导出：

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

冲突策略：

- SQLite 是第一版权威存储。
- 用户手动编辑 Markdown 后，双向同步必须显示 diff。
- 不允许静默覆盖数据库记忆。
- 发生冲突时创建 conflict note。

### 6.5 Vault 与工作图谱的关系

Vault 是工作图谱的可读镜像：

- Profile 导出为 `profiles/*.md`。
- Timeline 导出为 `timelines/*.md`。
- Relation 写入 frontmatter 和 backlinks。
- Evidence 独立导出为 `evidence/*.md`。
- Task Card 导出为 `tasks/*.md`。
- Skill feedback 和 patch 导出为 `skills/*.md`。

## 7. 主线四：Skill 使用中反馈与自动 Patch 闭环

### 7.1 目标

借鉴 Hermes Agent 的使用中改进机制，让 MetaClaw 不仅能 promotion skill，还能在 Skill 使用过程中发现问题并生成 patch 候选。

### 7.2 闭环流程

```text
Executor 使用 Skill
  ↓
执行中上报 SkillUsageEvent / Progress / Failure
  ↓
MetaClaw 观察失败、绕路、用户纠正、重复修复
  ↓
生成 SkillPatchCandidate
  ↓
SafetyScanner / PromotionGate 检查
  ↓
用户审核或低风险建议
  ↓
ExecutorAdapter.updateSkill
  ↓
后续任务验证 patch 是否有效
```

### 7.3 采集信号

- Executor 明确上报 skill failed。
- Executor 没按 skill 要求执行。
- 用户纠正 skill 输出。
- 同类任务重复出现相同失败。
- 执行器手动绕过原 skill。
- 测试失败后补了一步固定操作。
- 高频使用 skill 但耗时或失败率异常。
- 用户说“以后这个 skill 要先做 X”。

### 7.4 新增类型

```ts
interface SkillRuntimeFeedback {
  id: string;
  taskId: string;
  executorName: string;
  skillName: string;
  skillVersion: string | null;
  feedbackType:
    | 'success'
    | 'failure'
    | 'user_correction'
    | 'missing_step'
    | 'unsafe_step'
    | 'inefficient_step'
    | 'better_pattern_found';
  summary: string;
  evidenceIds: string[];
  createdAt: string;
}

interface SkillPatchCandidate {
  id: string;
  skillName: string;
  targetVersion: string | null;
  patchType: 'add_step' | 'remove_step' | 'modify_step' | 'add_guardrail' | 'update_verification';
  problem: string;
  proposedPatch: string;
  evidenceIds: string[];
  confidence: number;
  safetyStatus: 'pending' | 'safe' | 'blocked';
  status: 'pending' | 'approved' | 'rejected' | 'promoted';
}
```

### 7.5 用户命令

```text
/learning skill-feedback
/learning skill-feedback <skill>
/learning patch candidates
/learning patch approve <id>
/learning patch reject <id>
/learning patch promote <id>
```

### 7.6 第一版策略

第一版不直接自动修改 Skill，只生成 patch 候选。

示例：

```text
→ 检测到 Skill「飞书调试流程」连续 3 次需要补充 webhook 验证步骤，已生成 patch 候选。
```

第二版再考虑低风险自动建议，但仍不应绕过安全扫描和 promotion gate。

### 7.7 与 Evidence / Timeline / Vault 的关系

- 每条 SkillRuntimeFeedback 都生成 Evidence。
- 每次 SkillPatchCandidate 生成 Timeline event。
- Patch 与失败任务、用户纠正、Executor、Skill 建立 Relation。
- Vault 中导出 Skill 的使用历史、问题清单和 patch 记录。

## 8. 主线五：Executor 路由层

### 8.1 目标

MetaClaw 要成为上层大脑，根据任务意图、行业领域、输入材料、输出要求、风险等级、执行器能力和历史效果，把任务交给最合适的 Executor。

### 8.2 Executor Profile

```ts
interface ExecutorProfile {
  id: string;
  name: string;
  kind: 'coding' | 'research' | 'legal' | 'finance' | 'marketing' | 'general' | 'custom';
  command: string;
  description: string;
  domains: string[];
  capabilities: string[];
  inputTypes: Array<'text' | 'file' | 'web' | 'repo' | 'spreadsheet' | 'image'>;
  outputTypes: Array<'markdown' | 'code_patch' | 'report' | 'table' | 'slides' | 'message'>;
  strengths: string[];
  weaknesses: string[];
  riskLevel: 'low' | 'medium' | 'high';
  availability: 'available' | 'disabled' | 'missing' | 'degraded';
  priority: number;
}
```

配置示例：

```yaml
executors:
  default: codex
  profiles:
    - id: codex
      kind: coding
      command: codex
      domains: [software, repo, cli, tests]
      capabilities: [edit_files, run_tests, inspect_repo]
      strengths: [code_change, debugging, refactor]
    - id: legal-contract
      kind: legal
      command: legal-agent
      domains: [contract, compliance, risk]
      capabilities: [clause_review, risk_matrix]
      strengths: [legal_review, contract_summary]
    - id: market-research
      kind: research
      command: research-agent
      domains: [market, competitor, trend]
      capabilities: [web_research, synthesis]
      strengths: [deep_research, source_compare]
```

### 8.3 Task Understanding

```ts
interface TaskUnderstanding {
  intent: string;
  domain: string | null;
  inputTypes: string[];
  outputType: string | null;
  risk: 'low' | 'medium' | 'high';
  requiredCapabilities: string[];
}
```

### 8.4 Route Decision

```ts
interface ExecutorRouteDecision {
  executorId: string;
  confidence: number;
  reason: string;
  matchedCapabilities: string[];
  alternatives: Array<{
    executorId: string;
    score: number;
    reason: string;
  }>;
  requiresUserConfirmation: boolean;
}
```

### 8.5 路由原则

| 状态 | 行为 |
| --- | --- |
| 高置信 | 自动派发，只展示理由 |
| 中置信 | 询问用户选择 executor |
| 低置信 | 使用默认 executor，并说明可配置专用 executor |
| 高风险 | 即使高置信，也要求确认 |
| 用户显式指定 | 尊重用户指定 |

示例：

```text
→ 已派发给 legal-contract：检测到合同条款审查任务，输入包含 PDF，目标是风险矩阵。
```

### 8.6 路由反馈

每次路由都要记录：

- 任务理解结果。
- 候选 Executor 分数。
- 最终选择。
- 是否用户确认。
- 执行结果。
- 用户是否手动改派。

后续用于调整权重：

- 同类任务成功，提高 executor 权重。
- 同类任务失败，降低权重。
- 用户手动改派，生成偏好或路由规则候选。
- Executor 上报 Skill 效果，更新能力画像。

## 9. 分阶段路线图

| Phase | 主题 | 目标 |
| --- | --- | --- |
| Phase 1 | 记忆召回三态决策 | 大幅减少误召回和确认打扰 |
| Phase 2 | Evidence + Timeline 基础 | 每条记忆可解释、可追溯 |
| Phase 3 | Profile + Relation | 从偏好列表升级为工作图谱 |
| Phase 4 | Markdown / Obsidian Vault | 记忆资产本地可读、可导出 |
| Phase 5 | Skill Runtime Feedback | 收集 Skill 使用中问题 |
| Phase 6 | Skill Patch Loop | 自动生成 patch 候选并 promotion |
| Phase 7 | Executor Registry | 支持多个 Executor 能力画像 |
| Phase 8 | Executor Router | 根据任务选择最合适 Executor |

优先级：

```text
P0：记忆召回降噪
P1：高相关偏好自动采用
P2：Evidence / Timeline
P3：Profile / Relation
P4：Markdown Vault
P5：Skill runtime feedback + patch
P6：Executor registry
P7：Executor router
```

## 10. 实施约束

- 不一次性大改架构。
- 不绕过已有 TaskEngine、SchedulerEngine、RecallReview、ExecutorAdapter、Phase E 管道。
- 所有自动采用都必须可审计、可撤销。
- 所有长期记忆都必须有 evidence。
- 高风险动作不能因为记忆匹配而自动执行。
- Vault 第一版只做单向导出，避免同步冲突复杂度过早进入主线。
- Skill patch 第一版只生成候选，不自动修改执行器技能。
- Executor router 第一版必须保留默认 executor fallback。

## 11. 成功标准

产品体验：

- 用户明显更少看到无关 recall review。
- 高相关长期偏好能自然生效，不反复询问。
- 用户能解释每条记忆从哪里来、为什么被用。
- 用户能在本地 vault 中查看和管理长期记忆资产。
- Skill 会随着使用逐步产生 patch 候选。
- MetaClaw 能解释为什么把任务派给某个 Executor。

技术指标：

- Recall review 弹出率下降 70% 以上。
- Recall review 中用户标记不相关比例低于 20%。
- 高相关偏好 auto apply 成功率高于 60%。
- 每条长期记忆 evidence 覆盖率达到 100%。
- Skill patch candidate 能关联至少一个 feedback 和 evidence。
- Executor route event 覆盖率达到 100%。

## 12. 最终形态

优化后的 MetaClaw 应成为：

> 面向知识工作者和开发者的 Task Memory OS。它不是又一个聊天 Agent，而是能持续管理任务、记住项目状态、召回证据、选择执行器、沉淀技能改进，并把长期经验转化为用户可拥有资产的本地工作中枢。

