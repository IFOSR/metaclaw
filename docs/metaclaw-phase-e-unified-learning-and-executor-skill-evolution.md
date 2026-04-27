# MetaClaw Phase E：统一学习闭环与 Executor Skill 自进化方案

> **状态**：设计方案，待分阶段 TDD 实施  
> **位置**：`docs/metaclaw-phase-e-unified-learning-and-executor-skill-evolution.md`  
> **前置阶段**：Phase A/B/C/D 已完成历史召回、上下文分层、TaskRelevanceRanker、Recall Feedback Loop 相关优化。  
> **核心结论**：MetaClaw 管学习、审核、下发、观测和进化；Executor 管 Skill 安装、选择、调用和上报。

---

## 1. 背景与目标

当前 MetaClaw 已经具备几类基础能力：

1. **Preference / Observation**：记录用户稳定偏好、项目约定、表达方式等。
2. **Recall / History**：通过历史任务召回、Resume Context Pack、Reference Context Pack 帮助任务延续。
3. **Recall Feedback Loop**：用户对召回结果的 `select`、`irrelevant`、`hide`、`reject`、`more` 等反馈已经可以持久化并影响后续 recall。

但 MetaClaw 还缺少完整的“自学习闭环”：

```text
失败案例 → 反思 → 生成改进策略
成功流程 → 反思 → 生成 SkillCandidate
用户纠正 → 判断是偏好/流程/一次性要求
Executor 使用 Skill → 上报进度和效果
Skill 效果不好 → 生成升级建议
长期经验 → 定期复盘与受控沉淀
```

本阶段目标是建立 **Phase E：统一学习闭环 + Executor Skill 自进化观测链路**。

它不是把所有经验都塞进 Preference，也不是让 MetaClaw 接管 Skill runtime，而是建立一套可控学习机制：

```text
执行结果 / 用户反馈 / Executor 上报
  ↓
ReflectionEngine 反思
  ↓
LearningCandidate 候选
  ↓
CandidateClassifier 分类
  ↓
SafetyScanner / PromotionGate 安全审核
  ↓
用户 Review
  ↓
分别进入不同资产库
  ├── Preference：MetaClaw 自己用
  ├── Recall Feedback：MetaClaw 召回排序用
  ├── Task Memory Card：MetaClaw 历史参考用
  └── Executor Skill：下发给 Executor 安装/升级，运行时由 Executor 自己选用
```

---

## 2. 总体原则

### 2.1 可以合并学习管线，但不能合并资产类型

可以统一的是：

```text
执行 → 反思 → 候选 → 分类 → 安全检查 → Review → 持久化 → 后续使用
```

不能合并的是：

```text
Preference
Recall Feedback
Task Memory Card
Executor Skill
AntiPattern
Verification Recipe
```

原因：它们语义不同、使用方不同、注入优先级不同。

| 类型 | 回答的问题 | 消费方 | 示例 |
| --- | --- | --- | --- |
| Preference | 用户长期想要什么 | MetaClaw | 磊哥喜欢先结论后验收细节 |
| Recall Feedback | 哪些历史对当前任务有用/无用 | MetaClaw recall/ranking | 历史任务 A 对当前任务不相关 |
| Task Memory Card | 之前任务发生过什么 | MetaClaw 历史参考 | 某次 recall 改造改了哪些文件、怎么验收 |
| Executor Skill | 遇到某类任务应该怎么做 | Executor | 飞书回复截断调试流程 |
| AntiPattern | 哪些做法应该避免 | MetaClaw / Executor | 不要只看 TUI 验证飞书问题 |
| Verification Recipe | 某类任务如何验收 | MetaClaw / Executor | targeted tests + Feishu regression + lint + build |

### 2.2 Skill 的最终分工

经过讨论，Skill 归属和边界定为：

```text
MetaClaw 不选择 Skill。
MetaClaw 不在任务执行时指定 Skill。
MetaClaw 不要求同步 Executor 的全部 Skill inventory。
MetaClaw 只负责生成、审核、下发 Skill 安装或升级包。
Executor 自己安装、转格式、选择、调用 Skill。
Executor 使用 Skill 时必须上报进度和效果。
MetaClaw 把上报同步给用户，并基于效果生成升级建议。
```

一句话：

> **Executor owns Skill Runtime. MetaClaw owns Skill Learning, Governance, Observability and Evolution.**

### 2.3 TDD 与稳定性原则

Phase E 必须增量推进。每个小阶段都要：

1. 先写失败测试。
2. 确认失败原因符合预期。
3. 写最小实现。
4. 跑 targeted tests。
5. 跑相关 integration/regression。
6. 跑 `npm run lint`。
7. 跑 `npm run build`。
8. 确认飞书输出不截断、不泄露 thinking/reasoning、不影响 TUI。

不允许一次性大改架构，不允许绕过已有 TaskEngine、SchedulerEngine、RecallReview、ExecutorAdapter、Feishu/TUI 分层。

---

## 3. 学习资产分层设计

### 3.1 Preference / Observation

给 MetaClaw 自己用。

适合记录：

```text
用户稳定偏好
项目固定约定
回复格式偏好
验收标准偏好
长期工作方式
```

示例：

```text
磊哥更喜欢先给结论，再给验收细节。
开发任务必须跑 targeted tests + lint + build。
飞书回复不能截断，长文本要分段发送。
```

不能存：

```text
一次性要求
某次任务的临时判断
具体操作流程
失败堆栈原文
```

### 3.2 Recall Feedback

给 MetaClaw recall/ranking 用。

适合记录：

```text
这个历史候选有用
这个历史候选不相关
这个历史候选以后隐藏
用户想看更多候选
```

典型动作：

```text
select
irrelevant
hide
reject
more
```

边界：

```text
Recall Feedback 不等于用户偏好。
Recall Feedback 不等于 Skill。
Recall Feedback 只影响历史召回质量。
```

### 3.3 Task Memory Card

给 MetaClaw 未来参考历史任务用。

适合记录：

```text
任务摘要
关键决策
修改文件
验收命令
失败原因
最终结果
可复用注意事项
```

它回答的是：

```text
之前这个任务发生过什么？
```

不是：

```text
以后这类任务应该怎么做？
```

### 3.4 Executor Skill

给 Executor 安装和执行。

适合记录：

```text
可复用执行流程
调试方法
验收套路
反复踩坑的处理步骤
工具使用方法
特定项目的标准操作流程
```

示例：

```text
MetaClaw 飞书回复截断调试流程
MetaClaw Recall 改造 TDD 流程
Codex/Claude 长输出中断恢复流程
TypeScript repo 回归验收流程
```

边界：

```text
Skill 是给 Executor 安装和执行的。
MetaClaw 只生成候选、审核、下发安装/升级。
任务执行时 Executor 自己判断是否用 Skill。
Executor 用了 Skill 后必须上报。
```

---

## 4. 总体链路

### 4.1 任务执行链路

```text
用户需求
  ↓
MetaClaw 创建/调度任务
  ↓
MetaClaw 构造 Task Context Pack
  ↓
MetaClaw 下发任务给 Executor
  ↓
Executor 自行判断是否使用 Skill
  ↓
Executor 执行任务
  ↓
Executor 持续上报 SkillUsageEvent / Progress
  ↓
MetaClaw 记录事件并节流同步给用户
  ↓
Executor 返回最终结果
```

### 4.2 学习反思链路

```text
任务完成 / 失败 / 用户纠正 / Executor 上报 Skill 效果
  ↓
ReflectionEngine 读取任务证据
  ↓
生成 LearningCandidate
  ↓
CandidateClassifier 分类
  ↓
SafetyScanner 检查
  ↓
PromotionGate 决定是否需要用户审核
  ↓
用户 approve / reject / edit
  ↓
进入对应资产库
```

### 4.3 Skill 安装/升级链路

```text
SkillCandidate 或 SkillPatchCandidate 被用户认可
  ↓
MetaClaw 生成 PortableSkillPackage / SkillUpdatePackage
  ↓
MetaClaw 调用 ExecutorAdapter.installSkill / updateSkill
  ↓
Executor 转成自身格式并安装/升级
  ↓
Executor 返回安装/升级结果
  ↓
MetaClaw 记录 install/update event
```

### 4.4 Skill 使用观测链路

```text
Executor 开始使用 Skill
  ↓
上报 skill_started
  ↓
Executor 执行 Skill 步骤
  ↓
上报 skill_step_started / skill_step_completed / skill_progress
  ↓
Executor 完成或失败
  ↓
上报 skill_completed / skill_failed
  ↓
MetaClaw 同步用户 + 记录效果
  ↓
ReflectionEngine 生成 patch/upgrade/disable 建议
```

---

## 5. Phase E 分阶段实施方案

## Phase E1：LearningCandidate 基础设施

### 目标

建立统一候选机制。所有学习结果先进入候选池，不直接写入长期记忆或 Skill。

### 建议新增模块

```text
src/core/reflection-engine.ts
src/core/learning-candidate-classifier.ts
src/storage/learning-candidate-repo.ts
```

### 建议新增表

```text
reflection_events
learning_candidates
```

### 类型草案

```ts
type LearningCandidateKind =
  | 'preference'
  | 'recall_feedback'
  | 'task_memory_card'
  | 'executor_skill'
  | 'executor_skill_patch'
  | 'anti_pattern'
  | 'verification_recipe'
  | 'noop';

type LearningCandidateStatus =
  | 'candidate'
  | 'needs_review'
  | 'approved'
  | 'rejected'
  | 'promoted'
  | 'blocked'
  | 'disabled';

interface ReflectionInput {
  taskId: string;
  taskSummary: string;
  userRequest: string;
  finalOutcome: 'success' | 'failed' | 'cancelled' | 'partial';
  executorOutput?: string;
  changedFiles?: string[];
  commandsRun?: string[];
  verificationResults?: string[];
  failureTrace?: string[];
  userFeedback?: string[];
  skillUsageEvents?: SkillUsageEvent[];
}

interface LearningCandidate {
  id: string;
  kind: LearningCandidateKind;
  title: string;
  summary: string;
  evidence: string[];
  confidence: number;
  payload: unknown;
  status: LearningCandidateStatus;
}
```

### TDD 验收

先写测试：

```text
tests/core/reflection-engine.test.ts
tests/storage/learning-candidate-repo.test.ts
```

测试覆盖：

1. 一个成功任务能生成 `task_memory_card` candidate。
2. 一个用户明确纠正能生成 `preference` 或 `anti_pattern` candidate。
3. 一个复杂成功流程能生成 `executor_skill` candidate。
4. 所有 candidate 默认不自动生效。
5. candidate 可 list/view/reject。

建议命令：

```bash
npm test -- tests/core/reflection-engine.test.ts tests/storage/learning-candidate-repo.test.ts
npm run lint
npm run build
```

---

## Phase E2：SafetyScanner + PromotionGate + Review UX

### 目标

确保所有学习都经过安全检查和 review，不允许模型自己乱写长期资产。

### 建议新增模块

```text
src/core/safety-scanner.ts
src/core/promotion-gate.ts
src/session/learning-review-handler.ts
```

### SafetyScanner 检查项

```text
secret/token/key/password
.env/.ssh/credential 文件路径
绝对路径或 ../ path traversal
危险 shell 命令
prompt injection
把一次性要求误存为长期偏好
把失败流程误存为推荐流程
过大内容
```

### Review UX 示例

```text
MetaClaw 发现 3 条可学习候选：

[p1] 用户偏好候选
标题：飞书长回复需要分段发送
证据：用户明确要求“不要截断”
操作：approve p1 / reject p1 / edit p1

[s1] Executor Skill 候选
标题：MetaClaw 飞书回复截断调试流程
证据：本次任务修复了 splitForFeishu 并通过 feishu-app regression
操作：approve s1 / reject s1 / edit s1

[a1] 反模式候选
标题：不要只看 TUI 验证飞书问题
证据：TUI 正常但 Feishu 输出截断
操作：approve a1 / reject a1
```

### TDD 验收

先写测试：

```text
tests/core/safety-scanner.test.ts
tests/core/promotion-gate.test.ts
tests/session/learning-review-handler.test.ts
```

测试覆盖：

1. 含 secret 的 candidate 被 blocked。
2. 含危险路径的 Skill candidate 被 blocked。
3. 用户 approve 后才允许 promote。
4. 用户 reject 后不会再注入/安装。
5. 飞书展示不截断、不泄露 thinking/reasoning。

建议命令：

```bash
npm test -- tests/core/safety-scanner.test.ts tests/core/promotion-gate.test.ts tests/session/learning-review-handler.test.ts tests/integrations/feishu-app.test.ts
npm run lint
npm run build
```

---

## Phase E3：Executor Skill 安装/升级协议

### 目标

实现 Skill 正确归属：

```text
MetaClaw 生成 approved SkillPackage
Executor 安装/转格式/升级
任务执行时 Executor 自选 Skill
```

### 建议 Adapter 接口

```ts
interface ExecutorAdapter {
  installSkill?(pkg: PortableExecutorSkillPackage): Promise<SkillInstallResult>;
  updateSkill?(pkg: PortableExecutorSkillUpdatePackage): Promise<SkillUpdateResult>;
}
```

### Portable Skill Package 草案

```ts
interface PortableExecutorSkillPackage {
  id: string;
  name: string;
  version: string;
  title: string;
  description: string;
  tags: string[];

  content: {
    whenToUse: string;
    steps: string[];
    verification: string[];
    pitfalls: string[];
    examples?: string[];
  };

  evidence: {
    sourceTaskIds: string[];
    sourceCandidateId: string;
    successSignals: string[];
    failureSignals: string[];
    verificationCommands: string[];
  };

  safety: {
    reviewedByUser: boolean;
    secretScanPassed: boolean;
    riskFlags: string[];
  };
}

interface SkillInstallResult {
  requestId: string;
  status: 'installed' | 'failed' | 'unsupported' | 'skipped';
  executorSkillName?: string;
  executorSkillVersion?: string;
  executorSkillHash?: string;
  notes?: string;
  error?: string;
}
```

### 必须保持的边界

MetaClaw 不做：

```text
运行时选择 Skill
每次任务注入 relevant skills
同步 Executor 全部 Skill inventory
```

MetaClaw 只做：

```text
approved Skill 下发安装/升级
记录 install/update event
```

### TDD 验收

先写测试：

```text
tests/executor/executor-skill-install.test.ts
tests/session/learning-review-handler.test.ts
```

测试覆盖：

1. approved `executor_skill` candidate 会触发 `installSkill`。
2. Executor 不支持时返回 `unsupported`，任务执行不受影响。
3. 安装成功后记录 `skill_install_events`。
4. 后续任务 prompt 中不出现“MetaClaw 指定使用 Skill X”。
5. Executor 仍然只收到任务本身和必要上下文。

建议命令：

```bash
npm test -- tests/executor/executor-skill-install.test.ts tests/session/learning-review-handler.test.ts tests/executor/prompt-builder-context-layering.test.ts
npm run lint
npm run build
```

---

## Phase E4：SkillUsageEvent 观测链路

### 目标

让 Executor 使用 Skill 时对 MetaClaw 可观测，MetaClaw 再把关键进度同步给用户。

### 事件类型

```ts
type SkillUsageEventType =
  | 'skill_started'
  | 'skill_step_started'
  | 'skill_step_completed'
  | 'skill_progress'
  | 'skill_completed'
  | 'skill_failed'
  | 'skill_skipped'
  | 'skill_suggested_patch';
```

### 事件结构草案

```ts
interface SkillUsageEvent {
  eventId: string;
  taskId: string;
  executorRunId: string;
  executorId: string;
  timestamp: string;

  skill: {
    name: string;
    version?: string;
    source: 'metaclaw_installed' | 'executor_native' | 'executor_local' | 'ad_hoc';
    hash?: string;
  };

  eventType: SkillUsageEventType;

  progress?: {
    stepName?: string;
    stepIndex?: number;
    totalSteps?: number;
    message?: string;
    percent?: number;
  };

  outcome?: {
    status?: 'success' | 'failed' | 'partial' | 'skipped';
    helpful?: boolean;
    confidence?: number;
    evidence?: string[];
    missingSteps?: string[];
    failureReason?: string;
    suggestedPatch?: string;
  };

  visibility: {
    userVisible: boolean;
    userMessage?: string;
  };
}
```

### 建议新增表

```text
skill_usage_events
skill_effect_summaries
```

### 用户可见策略

需要新增：

```text
SkillProgressThrottler
```

规则：

```text
skill_started 必发
skill_completed / skill_failed 必发
step_completed 最多每 60～120 秒发一次
超过 3～5 分钟无输出，发 heartbeat
低价值事件只入库，不发给用户
```

### 用户可见示例

```text
Executor 正在使用技能「MetaClaw Recall 调试流程」处理当前任务。
```

```text
技能「MetaClaw Recall 调试流程」进度：已完成 2/5，正在运行 targeted tests。
```

```text
技能「MetaClaw Recall 调试流程」已完成，Executor 正在根据结果修复失败测试。
```

### TDD 验收

先写测试：

```text
tests/executor/skill-usage-events.test.ts
tests/session/skill-progress-throttler.test.ts
tests/storage/skill-usage-event-repo.test.ts
```

测试覆盖：

1. Executor 上报 `skill_started` 时，MetaClaw 入库并通知用户。
2. 高频 `skill_progress` 被节流。
3. `skill_completed` 入库并通知用户。
4. `skill_failed` 入库并通知用户，并不导致任务直接失败。
5. 飞书长消息不截断。
6. 事件中含 secret 时被脱敏或阻断用户可见输出。

建议命令：

```bash
npm test -- tests/executor/skill-usage-events.test.ts tests/session/skill-progress-throttler.test.ts tests/storage/skill-usage-event-repo.test.ts tests/integrations/feishu-app.test.ts
npm run lint
npm run build
```

---

## Phase E5：Skill 效果复盘与自动升级建议

### 目标

让 MetaClaw 根据 Executor 上报的 Skill 使用效果，生成 SkillPatchCandidate / DisableCandidate。

### 触发条件

```text
Skill helpful=false
Skill failed
Skill missingSteps 非空
Skill suggestedPatch 非空
同一 Skill 多次失败
同一 Skill 多次未使用但被安装
Executor 报告 Skill 与任务冲突
```

### 候选类型

```ts
type SkillEvolutionCandidateKind =
  | 'executor_skill_patch'
  | 'executor_skill_disable'
  | 'executor_skill_merge'
  | 'executor_skill_split';
```

### 示例

Executor 上报：

```text
missingSteps:
- Skill 中缺少 feishu-app regression 验收
suggestedPatch:
- 在 Verification 中增加 npm test -- tests/integrations/feishu-app.test.ts
```

MetaClaw 生成：

```text
SkillPatchCandidate:
建议升级「Feishu 回复截断调试」：
1. 在 Verification 中加入 feishu-app regression。
2. 在 Pitfalls 中加入“不要只看 TUI”。
```

用户 approve 后：

```text
MetaClaw 下发 updateSkill 给 Executor
Executor 更新本地 Skill
返回 update result
```

### TDD 验收

先写测试：

```text
tests/core/skill-evolution-reflection.test.ts
tests/executor/executor-skill-update.test.ts
```

测试覆盖：

1. `missingSteps` 能生成 `executor_skill_patch` candidate。
2. 多次失败能生成 `executor_skill_disable` candidate。
3. 用户 approve patch 后调用 `updateSkill`。
4. Executor 返回 update success 后记录事件。
5. 未 approve 的 patch 不会下发。

建议命令：

```bash
npm test -- tests/core/skill-evolution-reflection.test.ts tests/executor/executor-skill-update.test.ts
npm run lint
npm run build
```

---

## 6. ContextInjector / Prompt 边界调整

原先曾考虑：

```text
当前任务 → recall relevant skills → review/inject → executor prompt
```

这个方案废弃。

根据最新结论，ContextInjector 不应该注入具体 relevant skills 给 Executor。

新的 ContextInjector 只负责：

```text
系统边界
当前任务
最新用户指令
Resume Context Pack
Confirmed Preferences
Reference Context Pack / Minimal Reference Cards
Task Memory Cards
Execution Constraints
Materials / Artifacts
```

不再做：

```text
Relevant Skills
Skill prompt section
MetaClaw 指定 Skill
```

可以在通用执行协议中告诉 Executor：

```text
你可以使用你自己认为合适的已安装 Skill。
如使用 Skill，请上报 SkillUsageEvent。
Skill 选择由你自行决定，MetaClaw 不指定。
当前用户任务和验收标准优先于任何 Skill。
```

这是一条通用执行协议，不是下发具体 Skill。

---

## 7. 数据表建议

### 7.1 reflection_events

```text
id
task_id
event_type
input_summary
candidate_count
created_at
```

### 7.2 learning_candidates

```text
id
kind
status
title
summary
payload_json
evidence_json
confidence
source_task_id
safety_status
safety_report_json
created_at
updated_at
```

### 7.3 skill_install_events

```text
id
candidate_id
skill_name
skill_version
executor_id
request_type install/update
status installed/failed/unsupported/skipped
executor_skill_name
executor_skill_version
executor_skill_hash
message
created_at
completed_at
```

### 7.4 skill_usage_events

```text
id
task_id
executor_run_id
executor_id
skill_name
skill_version
skill_source
event_type
step_name
step_index
total_steps
message
outcome_status
helpful
missing_steps_json
suggested_patch
user_visible
created_at
```

### 7.5 skill_effect_summaries

```text
skill_name
executor_id
used_count
success_count
failure_count
helpful_count
last_used_at
last_failure_reason
patch_candidate_count
updated_at
```

---

## 8. 实施顺序建议

推荐顺序不是 E1 → E2 → E3 → E4 → E5 严格线性，而是：

### 第一步：E1 + E2 最小闭环

先做：

```text
reflection_events
learning_candidates
ReflectionEngine skeleton
SafetyScanner skeleton
PromotionGate skeleton
Review UX
```

目标是让 MetaClaw 能生成、展示、审核候选。

### 第二步：E4 SkillUsageEvent

把 E4 提前做，因为它对用户体验直接有价值：

```text
Executor 上报 Skill 使用进度 → MetaClaw 同步用户
```

这能解决长任务黑盒问题。

### 第三步：E3 installSkill / updateSkill

等 candidate 和 event 都有了，再做：

```text
approved Skill → 下发 Executor 安装
```

### 第四步：E5 自动升级建议

最后做：

```text
Skill usage effect → patch candidate → approve → updateSkill
```

---

## 9. 下一轮具体实施任务清单

下一轮建议从 **Phase E1/E2** 开始。

```text
e1. 基线复查：现有 observation/preference、task memory、executor adapter、session review 命令
e2. 设计并新增 learning_candidates / reflection_events schema + repo
e3. 新增 ReflectionEngine skeleton：从 task/executor result/user feedback 生成候选
e4. 新增 SafetyScanner / PromotionGate skeleton：secret/path/prompt-injection 基础检查
e5. 接入 session review UX：list/view/approve/reject learning candidates
e6. targeted tests：candidate repo、reflection classifier、safety scanner、review command
e7. regression：Recall Feedback、scripted session、Feishu、lint、build
```

每个实现环节都要遵守：

```text
RED：先写失败测试
GREEN：最小实现通过测试
REFACTOR：保持测试绿灯再整理
REGRESSION：跑相关回归 + lint + build
```

---

## 10. 每阶段必须跑的回归基线

除了阶段内 targeted tests，每个阶段完成前至少跑：

```bash
npm test -- tests/core/recall-feedback-loop.test.ts tests/core/hybrid-memory-recaller.test.ts tests/session/v2-proposal-and-recall-review.test.ts
npm test -- tests/executor/prompt-builder-context-layering.test.ts tests/session/scripted-session.test.ts tests/integrations/feishu-app.test.ts
npm run lint
npm run build
```

如果修改了 session、Feishu、Executor 输出链路，必须额外关注：

```text
飞书长回复不截断
不输出 thinking/reasoning
TUI 行为不被破坏
Executor 原始输出不直接暴露给用户
```

---

## 11. 完成标准

Phase E 全部完成后，应满足：

1. MetaClaw 可以从任务结果、用户反馈、Executor 上报中生成 LearningCandidate。
2. Candidate 会被分类为 Preference、Recall Feedback、Task Memory Card、Executor Skill、AntiPattern、Verification Recipe 等。
3. Candidate 默认不自动生效。
4. Candidate 经过 SafetyScanner 和 PromotionGate。
5. 用户可以 review / approve / reject / edit。
6. Approved Preference 进入 PreferenceRepo。
7. Recall Feedback 继续进入 RecallFeedbackRepo，不污染 Preference。
8. Approved Task Memory Card 可用于未来历史参考。
9. Approved Executor Skill 会下发给 Executor 安装/升级。
10. Executor 执行任务时自行选择 Skill。
11. Executor 使用 Skill 时上报 SkillUsageEvent。
12. MetaClaw 把关键 Skill 进度同步给用户，长任务不再黑盒。
13. MetaClaw 根据 Skill 使用效果生成升级/禁用/拆分/合并候选。
14. 所有新增能力都有 targeted tests、integration regression、lint、build 验证。

---

## 12. 最终结论

Phase E 的核心不是“给 MetaClaw 装 Skill”，而是建立一个可控的学习与进化系统：

```text
MetaClaw 负责学习、审核、下发、观测和进化。
Executor 负责安装、选择、调用和上报。
Preference、Recall Feedback、Task Memory Card、Executor Skill 分库治理。
所有长期沉淀都先变成候选，经过安全检查和用户审核后再生效。
每一步实施都用 TDD 验证，确保 MetaClaw 不崩溃、不回退、不变黑盒。
```
