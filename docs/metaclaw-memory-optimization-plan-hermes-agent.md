# MetaClaw 记忆系统优化方案：Hermes + OpenHuman 参考版

> **日期**：2026-05-17  
> **状态**：方案文档 / Hermes + OpenHuman 双参考版 / 待分阶段 TDD 实施  
> **证据边界**：Hermes 侧基于当前 Hermes Agent 机制与 MetaClaw 本地代码/文档检查；OpenHuman 侧未在本地仓库检索到完整报告原文，因此本版只抽取“OpenHuman-like / persona-agent / profile-memory 系统”的可借鉴架构模式，不声称已完整复现 OpenHuman 报告细节。  
> **背景**：Hermes Agent 已经把“用户偏好、环境事实、工具经验、技能流程、历史会话检索”拆成不同资产，并允许助手在满足规则时主动写入记忆或技能。OpenHuman-like 系统强调人/身份/关系/长期状态的结构化建模。MetaClaw 当前已有 Preference / Recall Review / LearningCandidate / TaskMemoryCard / SkillEffectSummary 等基础，但学习闭环仍偏“候选 + 用户介入”，对显式用户偏好、低风险事实、人物/项目长期画像和关系化证据的自动沉淀不足。

---

## 1. 结论先行

MetaClaw 的记忆优化不应简单复制 Hermes 的 `memory` tool，也不应把自己改造成 OpenHuman 式数字人/人格克隆系统，而应采用更适合 MetaClaw 的 **四层记忆 + 三档自动化 + 可撤销审计 + Profile/Relationship 长期状态层**：

```text
输入/执行/反馈
  ↓
Memory Capture Router：识别记忆意图与资产类型
  ↓
Evidence + Safety + Confidence Scoring：证据、风险、置信度打分
  ↓
Auto Policy：自动写入 / 静默候选 / 需要用户确认
  ↓
Asset Stores：Preference / Operating Principle / Profile / Relationship / Task Memory Card / Skill Candidate / Recall Feedback
  ↓
Context Injector：按任务场景分层召回，不污染当前任务
  ↓
Feedback / Decay / Rollback：使用效果、过期、撤销、合并
```

核心目标：

1. **减少用户介入**：用户明确表达稳定偏好时，MetaClaw 可以直接沉淀，而不是每次都问“是否记录”。
2. **避免乱记**：一次性任务、临时指令、推测性结论、无证据内容不进长期偏好。
3. **可解释可撤销**：每条记忆有来源、证据、风险等级、最后使用时间、撤销入口。
4. **分类更清楚**：不要把所有东西都塞进 Preference；流程进 Skill，事实进 Task/Project Memory，人物/项目长期状态进 Profile/Relationship，纠错进 Operating Principle 或 AntiPattern。
5. **执行时少污染**：召回结果按权威级别和用途分层注入；弱相关历史只作为 Reference Card。

---

## 2. 当前 MetaClaw 基线

基于当前代码检查，MetaClaw 已有以下基础：

| 能力 | 当前位置 | 现状 |
| --- | --- | --- |
| Preference / Observation | `src/core/memory-engine.ts` | 有 `observe`、`observeCandidate`、`confirm`、`addManual`、`recall`；存在三次阈值确认与手动添加路径。 |
| Recall Review | `MemoryEngine.recallForReview`、`RecallReviewBuilder`、Session Review | 已有执行前召回确认与 feedback loop，适合高风险历史召回。 |
| LearningCandidate | `src/storage/learning-candidate-repo.ts` | 已支持 `skill`、`preference`、`workflow`、`task_memory_card`、`skill_patch` 等候选。 |
| ReflectionEngine | `src/core/reflection-engine.ts` | 可从任务完成和 SkillUsageEvent 生成候选，但任务结果主要生成 `task_memory_card`，偏好自动提取不足。 |
| SafetyScanner / PromotionGate | `src/core/safety-scanner.ts`、`src/core/promotion-gate.ts` | 有基础 secret / dangerous command 检查；Promotion 仍是 pending → approved → promoted。 |
| Task Memory Card | `src/storage/task-memory-card-repo.ts` | 已形成任务事实资产，并已进入 recall 集成。 |
| Skill Effect Summary / Governance | `SkillUsageEventRepo`、`SkillEffectSummaryRepo`、`SkillGovernanceEngine` | 已能基于 Executor Skill 使用效果生成治理建议。 |
| Weekly Review | `src/core/learning-weekly-review-builder.ts`、`/learning weekly` | 已有周报入口，但偏报告，不负责自动沉淀。 |

问题不在“没有记忆系统”，而在：

- **记忆入口不够自然**：用户说“以后都这样”“记住这个偏好”时，没有足够强的直接写入路径。
- **学习候选过多依赖用户 review**：低风险、显式偏好也需要人工介入，打断感强。
- **资产类型分流还不完整**：Preference、Operating Principle、Project Fact、Skill、Task Card 的边界需要更显式。
- **证据与可撤销性不足**：记忆为什么被写入、来自哪句话、可否一键撤销，还没有作为一等公民。
- **自动沉淀策略缺少分档**：当前更多是“候选/审核”二元，缺少“安全低风险自动写入 + 摘要告知”。

---

## 3. Hermes Agent 可借鉴点

Hermes 的关键启发不是某个具体 API，而是资产分层和主动写入规则：

| Hermes 机制 | 对 MetaClaw 的启发 |
| --- | --- |
| `memory` tool 主动写入用户偏好、环境事实、工具 quirks | MetaClaw 需要“显式偏好/纠正 → 自动写入”的低打扰路径。 |
| `USER.md` / `MEMORY.md` 区分“用户是谁”和“环境/经验事实” | MetaClaw 应区分 UserProfile、ProjectProfile、ExecutorProfile、OperatingPrinciple。 |
| 不把任务进度存 memory，用 session search 召回 | MetaClaw 不应把临时任务进度写入 Preference；应进 Task State / Task Memory Card。 |
| 复杂流程沉淀为 Skill，普通事实沉淀为 Memory | MetaClaw 的 Workflow / Skill Candidate 应从 Preference 中拆出去。 |
| 记忆写成 declarative facts，避免 imperative 覆盖当前任务 | MetaClaw 需要 Memory Linter：禁止把命令式临时要求写成长期规则。 |
| Session Search 用于跨会话追溯 | MetaClaw 应加强 FTS / Timeline / Task Card recall，而不是把历史总结都塞进长期偏好。 |
| Skill 使用后发现缺陷就 patch skill | MetaClaw 已有 E4/E6 基础，应继续把 SkillUsageEvent 变成 patch/disable 候选。 |

### 3.1 OpenHuman-like 系统可借鉴点（证据边界版）

> 说明：本节基于当前可用的 OpenHuman-like / persona-agent / profile-memory 架构模式抽象，未把 OpenHuman 报告作为已完整读取的事实来源。对 MetaClaw 的建议只采用通用机制，不采用“数字人/形象/声线克隆”路线。

OpenHuman-like 系统与 MetaClaw 的核心差异可以概括为：

```text
OpenHuman-like：以人/Profile/身份连续性/关系/长期状态为中心
MetaClaw：以任务/执行器/上下文/技能治理/可恢复执行为中心
```

因此，对 MetaClaw 最有价值的不是“人格化”，而是把“人和项目的长期状态”作为结构化资产接入任务执行：

| OpenHuman-like 机制 | 对 MetaClaw 记忆系统的启发 |
| --- | --- |
| User/Profile 建模 | 把用户偏好拆成 UserProfile、ContactProfile、ProjectProfile、ExecutorProfile，而不是只用自由文本 Preference。 |
| Timeline / Life-log / Event 流 | 为用户纠正、项目决策、任务阶段、Skill 演化建立时间线，解决“什么时候变的、为何变的”。 |
| Relationship Graph | 建立 User / Project / Task / Skill / Decision / Artifact / Evidence 的关系，召回时按关系路径找证据，而不是只靠关键词。 |
| Identity / State Continuity | MetaClaw 可借鉴“长期状态连续性”，但对象应是工作状态、项目阶段、未决事项、风险，而不是数字人格。 |
| Memory Provenance | 每条记忆带来源、证据、置信度、适用范围、冲突策略，避免无证据记忆污染执行。 |
| Consent / Privacy Boundary | 个人画像、关系数据、敏感事实必须比普通任务卡更严格：默认最小化、可审计、可撤销。 |

落到 MetaClaw，本方案新增一个原则：

> **Task-first 不变，但任务执行前应能看到相关的人、项目、关系、历史决策和未决状态；这些内容以结构化 Profile/Relationship/Timeline 注入，而不是混进 prompt 里的泛泛历史总结。**


---

## 4. 目标资产模型

### 4.1 Preference：稳定偏好

回答：**用户长期想要什么 / 不想要什么？**

适合：

- 输出风格：先结论后细节、要验收明细。
- 工作方式：开发任务默认直接做，不默认外包 agent。
- 工具偏好：飞书文档适合沉淀完整方案。
- 用户明确说：记住、以后、默认、不要再。

不适合：

- 单次任务要求。
- 某次执行进度。
- 复杂操作流程。
- 没证据的模型推测。

### 4.2 Operating Principle：高优先级工作原则

回答：**MetaClaw 自己应该遵守哪些长期工作原则？**

这类内容比普通 Preference 更像“运行准则”，但不能混进系统提示。需要字段：

```ts
interface OperatingPrinciple {
  id: string;
  scope: 'global' | 'project' | 'contact';
  title: string;
  statement: string;        // declarative fact, not imperative prompt
  sourceInteractionId: string;
  evidenceQuote: string;
  confidence: number;
  status: 'active' | 'deprecated' | 'conflicted';
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

示例：

```text
磊哥要求开发任务由 MetaClaw/Hermes 默认直接完成，只有明确指定外部 agent 时才委托。
```

### 4.3 Project / Contact / Executor Profile

回答：**某个项目、联系人、执行器的长期事实是什么？**

- ProjectProfile：项目栈、验收命令、架构边界、文档位置。
- ContactProfile：沟通对象偏好、称呼、渠道约定。
- ExecutorProfile：某 Executor 支持哪些 install/update/disable 能力、已知限制。

### 4.4 Relationship / Timeline：关系与时间线

回答：**某条记忆、任务、决策、项目状态之间是什么关系？什么时候发生、为什么发生？**

建议引入两类轻量资产：

```ts
interface MemoryEvent {
  id: string;
  eventType: 'preference_changed' | 'project_decision' | 'task_completed' | 'skill_promoted' | 'correction' | 'risk_detected';
  subjectKind: 'user' | 'project' | 'task' | 'skill' | 'memory' | 'artifact';
  subjectId: string;
  evidenceQuote?: string;
  sourceInteractionId?: string;
  occurredAt: string;
}

interface MemoryRelation {
  id: string;
  fromKind: string;
  fromId: string;
  relation: 'supports' | 'updates' | 'conflicts_with' | 'derived_from' | 'used_by' | 'belongs_to';
  toKind: string;
  toId: string;
  confidence: number;
  createdAt: string;
}
```

用途：

- 回答“这个偏好从哪里来”。
- 判断“旧项目决策是否已被新指令覆盖”。
- 把 TaskMemoryCard、ProjectProfile、OperatingPrinciple、SkillUsageEvent 串成可追溯证据链。
- 为后续 weekly journal / project state review 提供结构化输入。

### 4.5 Task Memory Card

回答：**之前某个任务具体发生了什么？**

保留当前方向：只记录事实、决策、文件、验证、坑点、产物，不写成长期偏好。

### 4.6 Skill / Workflow / Verification Recipe

回答：**以后遇到同类任务怎么做？**

- 复杂流程 → Skill Candidate。
- 简短验收方式 → Verification Recipe。
- 失败经验 → AntiPattern。
- Skill 效果差 → Skill Patch / Disable / Deprecation。

### 4.7 Recall Feedback

回答：**某个历史候选对某个查询是否有用？**

保持独立，不升级为 Preference。

---

## 5. 三档自动化策略

### 5.1 Auto-Commit：低风险显式记忆，自动写入

满足全部条件时自动写入，回复里简短告知即可：

1. 用户显式要求记忆：`记住`、`以后`、`默认`、`不要再`、`我偏好`、`我的习惯是`。
2. 内容不包含 secret / token / password / 私密身份敏感信息。
3. 内容不是一次性任务进度或临时指令。
4. 分类置信度高于阈值，例如 `confidence >= 0.85`。
5. 与现有记忆无明显冲突；若是更新已有记忆，保留旧版本 audit。

用户体验：

```text
已更新记忆：以后开发任务默认由我直接完成，不默认委托外部 agent。
```

而不是：

```text
检测到可能偏好，是否保存？
```

### 5.2 Silent Candidate：中风险内容，生成候选但不打断

适合：

- 模型从执行结果中推断出的流程经验。
- 任务完成后生成的 Task Memory Card。
- Skill patch / AntiPattern / Verification Recipe。
- 置信度中等或缺少直接用户授权。

用户体验：

- 不在当前主回复里强制打断。
- 进入 `/learning candidates`、`/learning weekly`、任务结束摘要里的“可审核候选”。

### 5.3 Review Required：高风险或冲突内容，必须确认

适合：

- 删除 / 覆盖已有原则。
- 安全策略、权限、自动执行策略。
- 含敏感信息、凭据、身份隐私。
- 与当前记忆冲突。
- 会影响 Executor skill install/update/disable 的 side effect。

---

## 6. 新增核心模块设计

### 6.1 `MemoryCaptureRouter`

位置：`src/core/memory-capture-router.ts`

职责：从用户输入、任务结果、执行器上报中识别是否产生记忆资产。

输入：

```ts
interface MemoryCaptureInput {
  sourceType: 'user_turn' | 'task_completion' | 'executor_skill_usage' | 'recall_feedback';
  sourceId: string;
  taskId?: string;
  userInput?: string;
  assistantOutput?: string;
  executorOutput?: string;
  metadata?: Record<string, unknown>;
}
```

输出：

```ts
interface MemoryCaptureDecision {
  action: 'auto_commit' | 'silent_candidate' | 'review_required' | 'ignore';
  assetKind:
    | 'preference'
    | 'operating_principle'
    | 'project_profile_fact'
    | 'contact_profile_fact'
    | 'executor_profile_fact'
    | 'memory_event'
    | 'memory_relation'
    | 'task_memory_card'
    | 'skill'
    | 'skill_patch'
    | 'verification_recipe'
    | 'antipattern'
    | 'recall_feedback';
  confidence: number;
  risk: 'low' | 'medium' | 'high';
  reason: string;
  evidenceQuote: string;
  normalizedContent: string;
  targetExistingId?: string;
}
```

### 6.2 `MemoryClassifier`

职责：区分：

- 显式偏好 vs 临时指令。
- 偏好 vs 项目事实。
- 流程经验 vs 任务事实。
- 用户纠正 vs 市场/事实结论。

规则优先，LLM 辅助。第一版可用启发式规则：

| 信号 | 分类倾向 |
| --- | --- |
| “以后 / 默认 / 记住 / 不要再” | Preference / Operating Principle |
| “这个项目 / marketing-os / metaclaw” | ProjectProfile |
| “这次任务 / 刚才 / 当前” | Working Memory，不进长期偏好 |
| “步骤 / 流程 / 验收命令 / 下次遇到” | Skill / Verification Recipe |
| “你刚才错了 / 不是 X 而是 Y” | Correction → Preference / ProjectFact / AntiPattern |

### 6.3 `MemoryAutoPolicy`

职责：根据 evidence、risk、confidence、conflict 决定自动化等级。

伪代码：

```ts
if (safety.blocked) return review_required;
if (hasConflict) return review_required;
if (explicitUserMemoryIntent && lowRisk && confidence >= 0.85) return auto_commit;
if (sourceType === 'task_completion') return silent_candidate;
if (assetKind.startsWith('skill')) return silent_candidate;
return ignore;
```

### 6.4 `MemoryAuditRepo`

每次自动写入、候选、更新、撤销都记 audit。

```ts
interface MemoryAuditEvent {
  id: string;
  assetKind: string;
  assetId: string;
  action: 'auto_commit' | 'candidate_created' | 'approved' | 'promoted' | 'updated' | 'rejected' | 'reverted';
  sourceType: string;
  sourceId: string;
  evidenceQuote: string;
  reason: string;
  createdAt: string;
}
```

### 6.5 `ProfileMemoryStore` / `RelationshipMemoryStore`

职责：把 OpenHuman-like 的 Profile / Timeline / Relationship 能力压缩成 MetaClaw 可用的工作记忆层。

- `ProfileMemoryStore`：管理 UserProfile、ProjectProfile、ContactProfile、ExecutorProfile。
- `TimelineEventRepo`：记录偏好变化、项目决策、用户纠正、任务完成、Skill 演化。
- `MemoryRelationRepo`：记录记忆资产之间的 supports / conflicts_with / derived_from / used_by 等关系。
- 第一版不做复杂图数据库，可先用 SQLite 表 + 索引；只有当关系查询成为瓶颈时再考虑图存储。

### 6.6 `MemoryLinter`

写入前检查：

- 是否是命令式提示注入：`你必须永远...`、`忽略系统...`。
- 是否包含 secret。
- 是否包含临时任务状态：`当前正在...`。
- 是否过长。
- 是否无来源证据。
- 是否与现有记忆冲突。

---

## 7. 数据库与类型改造

### 7.1 扩展 `preferences`

建议增加或模拟字段：

```sql
ALTER TABLE preferences ADD COLUMN source_interaction_id TEXT;
ALTER TABLE preferences ADD COLUMN evidence_quote TEXT;
ALTER TABLE preferences ADD COLUMN confidence_reason TEXT;
ALTER TABLE preferences ADD COLUMN auto_committed INTEGER DEFAULT 0;
ALTER TABLE preferences ADD COLUMN supersedes_id TEXT;
ALTER TABLE preferences ADD COLUMN last_verified_at TEXT;
```

若不想改旧表，可先新增 `memory_audit_events` 记录来源。

### 7.2 新增 `operating_principles`

```sql
CREATE TABLE operating_principles (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  source_interaction_id TEXT,
  evidence_quote TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_applied_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 7.3 新增 `memory_audit_events`

```sql
CREATE TABLE memory_audit_events (
  id TEXT PRIMARY KEY,
  asset_kind TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  action TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  evidence_quote TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
```

### 7.4 新增 `memory_events` 与 `memory_relations`

```sql
CREATE TABLE memory_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  source_interaction_id TEXT,
  evidence_quote TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE memory_relations (
  id TEXT PRIMARY KEY,
  from_kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL
);
```

### 7.5 扩展 `learning_candidates`
建议增加：

```sql
ALTER TABLE learning_candidates ADD COLUMN confidence REAL DEFAULT 0.5;
ALTER TABLE learning_candidates ADD COLUMN risk_level TEXT DEFAULT 'medium';
ALTER TABLE learning_candidates ADD COLUMN evidence_quote TEXT;
ALTER TABLE learning_candidates ADD COLUMN auto_policy TEXT;
```

---

## 8. 用户体验设计

### 8.1 自动记忆后的简短提示

当用户显式给偏好：

```text
以后调研类输出都同步飞书文档。
```

MetaClaw 回复中附加一行：

```text
已更新记忆：调研类完整输出优先同步飞书文档，便于审阅和沉淀。
```

### 8.2 可撤销入口

新增命令：

```text
/memory recent
/memory forget <id>
/memory edit <id>
/memory audit <id>
```

`/memory recent` 示例：

```text
最近记忆变更：
#mem_123 [auto] Preference：调研类完整输出优先同步飞书文档
  来源：2026-05-17 用户消息 “以后调研类输出...”
  操作：/memory forget mem_123
```

### 8.3 周报不再只是候选堆积

`/learning weekly` 应新增：

- 本周自动写入记忆 N 条。
- 本周被使用最多的记忆。
- 本周冲突/过期记忆。
- 需要用户审核的高风险候选。

---

## 9. Context 注入策略

记忆写入优化必须与召回注入配套，否则会“越记越污染”。

### 9.1 注入优先级

```text
system boundary
> latest user instruction
> current task goal
> resume snapshot
> operating principles
> explicit user preferences
> project/contact/executor profile facts
> relationship/timeline evidence
> accepted task memory cards
> weak similar references
> recent session context
```

### 9.2 注入预算

建议为每类资产设置默认 token budget：

| 资产 | 默认预算 | 说明 |
| --- | --- | --- |
| Operating Principles | 800 | 只注入当前场景相关原则。 |
| User Preferences | 800 | 只注入显式相关偏好。 |
| Project / Contact / Executor Profile | 1000 | 当前项目、联系人、执行器相关长期事实。 |
| Relationship / Timeline Evidence | 800 | 只注入与当前任务直接相关的关系和事件链。 |
| Task Memory Cards | 1500 | 已接受或高置信相关。 |
| Weak References | 800 | 最多 3 条，只做参考。 |

### 9.3 冲突处理

当新用户输入与记忆冲突：

- 当前用户输入优先。
- 标记记忆为 possible_conflict。
- 不自动覆盖，除非用户明确说“以后改成”。

---

## 10. 分阶段实施计划

> 原则：每阶段先写测试，确认 RED，再最小实现，最后跑 targeted tests + recall/session regression + lint/build。

### Phase M1：显式偏好自动写入

**目标**：用户明确表达“记住/以后/默认/不要再”时，低风险偏好自动写入 Preference，并回复告知。

**新增文件**：

- `src/core/memory-capture-router.ts`
- `src/core/memory-classifier.ts`
- `src/core/memory-auto-policy.ts`
- `tests/core/phase-m1-memory-capture-router.test.ts`
- `tests/session/phase-m1-auto-memory-capture.test.ts`

**改动文件**：

- `src/session/metaclaw-session.ts`：普通用户输入后调用 Capture Router。
- `src/core/memory-engine.ts`：增加 `addAutoCommitted(...)` 或复用 `addManual(...)` 并写 audit。
- `src/storage/migrations.ts`：增加 audit 表或 preference 来源字段。

**测试要点**：

1. “以后开发任务默认直接做” → 自动写入 preference。
2. “这次先不用跑测试” → 不写长期 preference。
3. 包含 `token=...` → 不自动写入，进入 blocked/review。
4. 与已有偏好冲突 → review_required。
5. 回复包含“已更新记忆”，但不打断任务执行。

**验收命令**：

```bash
npm test -- tests/core/phase-m1-memory-capture-router.test.ts tests/session/phase-m1-auto-memory-capture.test.ts tests/core/memory-engine.test.ts tests/session/memory-round1-acceptance.test.ts
npm run lint
npm run build
```

### Phase M2：Memory Audit + 撤销编辑

**目标**：自动写入可追踪、可撤销、可编辑。

**新增文件**：

- `src/storage/memory-audit-event-repo.ts`
- `tests/storage/phase-m2-memory-audit-storage.test.ts`
- `tests/commands/phase-m2-memory-recent-forget-edit.test.ts`

**改动文件**：

- `src/commands/memory-commands.ts`
- `src/storage/migrations.ts`

**命令**：

```text
/memory recent
/memory audit <asset_id>
/memory forget <asset_id>
/memory edit <asset_id> <new_content>
```

**验收命令**：

```bash
npm test -- tests/storage/phase-m2-memory-audit-storage.test.ts tests/commands/phase-m2-memory-recent-forget-edit.test.ts tests/session/phase-m1-auto-memory-capture.test.ts
npm run lint
npm run build
```

### Phase M3：Operating Principle 与 Profile Fact 分流

**目标**：把高优先级工作原则、项目事实、联系人事实从普通 Preference 中拆出来。

**新增文件**：

- `src/storage/operating-principle-repo.ts`
- `src/storage/project-profile-repo.ts`
- `src/core/profile-memory-router.ts`
- `tests/core/phase-m3-memory-asset-classification.test.ts`

**测试要点**：

1. “开发任务默认由你直接完成” → Operating Principle。
2. “marketing-os 的 v2.2 commit 是 a56c1fb” → ProjectProfile fact。
3. “我喜欢回答简洁点” → Preference。
4. “刚才那个任务停一下” → Working Memory，不持久化。

### Phase M3.5：Profile / Timeline / Relationship 最小闭环

**目标**：吸收 OpenHuman-like 系统的长期状态优势，但只服务工作执行，不做人设/数字人克隆。

**新增文件**：

- `src/storage/profile-memory-repo.ts`
- `src/storage/memory-event-repo.ts`
- `src/storage/memory-relation-repo.ts`
- `src/core/profile-memory-router.ts`
- `tests/core/phase-m35-profile-relationship-memory.test.ts`

**测试要点**：

1. 用户纠正“LLM Wiki v2 不是 VR” → 写入 correction event，并关联到对应 Project/Profile fact。
2. 项目决策更新时，新事件与旧事件形成 `updates` 或 `conflicts_with` 关系。
3. 执行任务时只注入当前项目相关 Profile/Relationship evidence，不注入无关人物画像。
4. Profile/Relationship 资产带来源证据，可在 `/memory audit` 查看。

### Phase M4：任务完成后的智能候选降噪

**目标**：ReflectionEngine 不再每个成功任务都生成泛泛 Task Memory Card；只在有可复用信息、产物、决策、验证命令时生成候选。

**改动文件**：

- `src/core/reflection-engine.ts`
- `src/core/safety-scanner.ts`
- `tests/core/phase-m4-reflection-candidate-quality.test.ts`

**规则**：

- 无产物、无决策、无验证 → 不生成候选或低优先级。
- 有文件改动、验收命令、坑点 → 生成 Task Memory Card。
- 有重复流程 + 5 次以上工具调用/错误修复 → Skill Candidate。
- 有用户纠正 → Preference / Operating Principle candidate 或 auto-commit。

### Phase M5：Context Injector 统一预算与记忆来源标注

**目标**：执行器 prompt 中明确区分记忆类型、权威级别、来源，减少“记忆污染当前任务”。

**改动文件**：

- `src/executor/prompt-builder.ts`
- `src/core/resume-context-builder.ts`
- `src/core/memory-engine.ts`
- `tests/executor/phase-m5-memory-context-injection.test.ts`

**验收标准**：

- Operating Principle 出现在 preference 前。
- Weak Reference 不覆盖 latest user instruction。
- 每条长期记忆带 `source/reason` 的短标注。
- 超预算时优先保留当前任务和显式偏好。

### Phase M6：记忆使用反馈、衰减与冲突治理

**目标**：MetaClaw 不仅会写记忆，还会知道记忆是否有用、是否过期、是否冲突。

**新增能力**：

- `memory_usage_events`
- `last_used_at`、`use_count`、`helpful_count`、`conflict_count`
- `/memory conflicts`
- `/learning weekly` 显示过期/冲突记忆

---

## 11. 关键产品规则

### 11.1 什么情况下不要问用户

- 用户明确说“记住 X / 以后 X / 默认 X / 不要再 X”。
- 内容明显是低风险偏好或工作方式。
- 没有冲突、没有安全风险。

这种情况直接写入，并一句话告知。

### 11.2 什么情况下必须问用户

- 要覆盖旧记忆。
- 要改变自动执行权限。
- 要安装、更新、禁用 Executor Skill。
- 内容涉及凭据、安全、隐私。
- 模型只是从行为中推断，不是用户明确表达。

### 11.3 什么情况下完全不记

- 单次任务进度。
- “这次先...”类临时指令。
- 无来源证据的推测。
- 可从数据库确定查询的临时状态。
- 原始大段日志和错误堆栈。

---

## 12. 与现有 Phase E 的关系

本方案不是推翻 Phase E，而是在 Phase E 基础上补齐“低打扰记忆写入”层：

| Phase E 已有 | 本方案补强 |
| --- | --- |
| LearningCandidate + Review | 增加 Auto-Commit 档，显式低风险偏好不再强制 review。 |
| Task Memory Card | 增加候选质量门槛，避免泛泛卡片。 |
| Preference / Project Fact | 增加 Profile / Timeline / Relationship 层，让长期状态和证据链结构化。 |
| Skill Usage / Governance | 保持 review/promotion side effect 边界。 |
| Weekly Review | 增加自动记忆、冲突、过期、使用效果。 |
| Recall Review | 保留高风险召回确认；低风险偏好写入不需要反复确认。 |

---

## 13. 成功指标

### 产品体验指标

1. 用户明确偏好后，MetaClaw 能在同轮或任务结束时提示“已更新记忆”。
2. 用户不需要频繁确认低风险偏好。
3. 用户/项目/执行器长期状态能以 Profile/Timeline 方式沉淀，而不是散落在自由文本偏好里。
4. `/memory recent` 可以看到最近自动写入内容并撤销。
5. 执行时召回的记忆更少但更准。
6. 一次性任务要求不会污染长期偏好。

### 工程指标

1. 自动写入路径有审计记录。
2. 所有自动写入都经过 SafetyScanner / MemoryLinter。
3. 冲突记忆不会静默覆盖。
4. Full test / lint / build 通过。
5. Feishu 输出仍不截断、不泄露 reasoning、不影响 TUI。

---

## 14. 推荐下一步

建议先做 **Phase M1 + M2**，因为它们直接解决“用户介入太多”的痛点：

1. M1 让显式偏好自动写入。
2. M2 给自动写入加 audit / recent / forget，降低误记风险。

完成 M1/M2 后，再推进 M3 与 M3.5；等 Profile / Timeline / Relationship 的证据链稳定后，再推进 M4/M5，避免一开始就改太大导致 recall 和 session 行为不稳定。
