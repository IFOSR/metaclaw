# Metaclaw

> 任务连续性、偏好记忆与主动编排中枢

Metaclaw 是一个面向知识工作者的 TUI 应用，专注解决三个核心问题：

1. **Continuity（连续性）** — 任务被打断后能无缝恢复，跨天、跨会话保持上下文
2. **Memory（记忆）** — 自动沉淀用户偏好，减少重复说明
3. **Guidance（引导）** — 主动告诉你现在该做什么、哪里卡住了

当前版本已经进入 V2 交互流：

- 主动建议升级为需要用户确认的 `操作提案`
- memory 命中后不再默认静默注入，而是先进入 `记忆召回确认`
- 用户可按场景授权后续同类 recall 自动采用
- 支持本地 Gateway，多 terminal 连接同一个 Metaclaw 实例，共享任务、记忆和执行器底座
- 支持 Phase E 学习闭环：任务记忆卡、Skill 候选、Skill patch、Skill 治理和周报
- 支持飞书通知/应用集成，以及本地 Markdown preview

## 快速开始

### 安装

要求 Node.js `>=20`，并确保默认执行器 `codex` 可用。

```bash
npm install
npm run build
npm link
```

### 运行

```bash
metaclaw
```

也可以使用项目脚本启动：

```bash
./metaclaw.sh start
```

首次启动会在 `~/.metaclaw/` 创建配置和数据库。
默认执行器是 `codex`，仍保留 `claude` 兼容入口。

### 连接已运行的 Metaclaw

如果一个 terminal 已经启动了 Metaclaw，再开第二个 terminal 时不要重复 `start`。使用本地 Gateway 连接当前实例：

```bash
./metaclaw.sh connect
```

每个 `connect` 都会在主 Metaclaw 进程内创建独立 `session_id`，共享任务、记忆和执行器底座，但会话近期上下文按 session 隔离，不会把两个 terminal 的普通对话混在一起。

`connect` 使用和主进程一致的 Ink TUI 外观，并在状态区显示 `模式 client` 和当前 gateway session；非 TTY 管道场景会自动降级为简化文本客户端。

### 运行状态与日志

```bash
./metaclaw.sh status
./metaclaw.sh logs
./metaclaw.sh logs -f
./metaclaw.sh stop
./metaclaw.sh restart
```

`metaclaw.sh` 会在启动前检查源码是否比 `dist/index.js` 更新；如果需要，会自动执行 `npm run build`。

CLI 也支持直接运行 Gateway 或连接 Gateway：

```bash
metaclaw --gateway
metaclaw --connect
```

### 脚本化烟测

```bash
cat > /tmp/metaclaw-flow.txt <<'EOF'
帮我整理三份合同的风险点对比表
/tasks done
EOF

metaclaw --script /tmp/metaclaw-flow.txt
```

`--script` 会按行执行输入脚本，适合做可重复的端到端烟测。空行和以 `#` 开头的注释会被忽略。

### 发布前验收入口

- 分轮验收包：`examples/e2e/`
- 用户试用场景：`examples/trial-scenarios/`

## 核心功能

### 任务管理与执行

```bash
# 创建任务并自动执行（自然语言）
> 帮我整理三份合同的风险点对比表
→ 任务 #task_abc123 已创建：帮我整理三份合同的风险点对比表
→ 派发给 codex-cli...
→ 正在执行任务 #task_abc123...
· #task_abc123 已启动 codex-cli 执行器
· 正在等待执行器返回...
✓ 任务完成 (12.3s)

┌─ 任务结果 ───────────────────────────────────────┐
│ 摘要: [结果摘要...]
│ 下一步: 如需延续，可基于当前结果继续创建 follow-up 任务
└──────────────────────────────────────────────────┘

[执行器输出结果...]

💡 建议：继续处理任务 #task_xyz456: 审核财务报表

# 后续指令会继续在当前任务上下文中执行
> 继续，把表格导出为 Excel
→ 正在执行任务 #task_abc123...
✓ 任务完成 (5.2s)

# 查看任务
/tasks              # 所有任务
/tasks active       # 活跃任务
/tasks ready        # 待执行任务
/tasks parked       # 已挂起任务
/tasks blocked      # 阻塞任务
/tasks done         # 已完成任务

# 任务操作
/task <id>          # 查看详情
/task <id> pause    # 暂停
/task <id> resume   # 恢复
/task <id> block 等待客户资料  # 标记阻塞
/task <id> unblock  # 解除阻塞
/task <id> unblock /tmp/evidence-v3.pdf  # 解除阻塞并附带新材料
/task <id> cancel   # 取消
/task <id> done     # 完成

# 任务详情会展示
# - 最新结果摘要
# - 本地文件材料 / 网页链接材料
# - 材料概览 / 材料状态
# - 任务产物
```

### TUI 体验

```text
当前执行 1 | 待执行 0 | 已挂起 0 | 阻塞 0
最近事件 开始执行任务 #task_abc123

status: running codex-cli
> 
```

新的终端界面会把输出分成几类：

- `> ` 用户输入
- `→` 系统路由、调度、上下文准备
- `· #task...` 执行器进度步骤
- `· 正在等待执行器返回...` 静默等待提示
- `✓ 任务完成` 结果块头部

### 偏好记忆与自动提取

```bash
# 系统自动观察重复模式
> 用正式语气回复张总
[执行...]

> 用正式语气回复李总
[执行...]

> 用正式语气回复王总
[执行...]
💡 检测到重复模式（3次）："用正式语气"
   要把它记为长期偏好吗？
   [y] 确认  [n] 忽略  [e <新内容>] 编辑后确认

# 也可以继续用命令确认
/memory confirm obs_123 --scope contact --subject 张总
已确认偏好 #pref_abc: 用正式语气

# 查看偏好
/memory             # 已确认偏好
/memory candidates  # 待确认偏好（出现3次后）

# 手动添加
/memory add 张总偏好正式语气，必须抄送法务
/memory add --scope contact --subject 张总 张总偏好正式语气，必须抄送法务

# 搜索、编辑和删除
/memory search 正式
/memory edit <pref_id> --scope project 输出统一使用表格
/memory delete <pref_id>
/memory stats
```

### 材料与产物

```bash
# 直接在自然语言里附带文件和链接材料
> 基于 ./weekly.md 和 https://example.com/report 整理 Phoenix 周报

# /task 详情里会拆开展示
# - 本地文件材料
# - 网页链接材料
# - 材料概览
# - 材料状态

# 如果任务要求把结果写到目录
> 把刚才的分析保存成 markdown 文件

# 执行成功后，Metaclaw 会记录任务产物路径
> /task <id>
任务产物: /abs/path/to/output.md
```

### 高风险动作门控

```bash
> 直接把邮件发给客户
⚠️ 这是高风险动作，默认不会直接执行。
→ 输入“确认执行”后继续，或输入“取消执行”放弃。

> 确认执行
→ 已确认高风险动作，继续执行原请求
```

### V2 提案与记忆召回确认

```text
┌─ 操作提案 ───────────────────────────────────────┐
│ 场景：启动建议
│ 动作：建议恢复任务 #task_123: Phoenix 周报整理
│ 理由：已完成 80%，继续成本更低
│ 请输入 [y] 接受并继续恢复 / [n] 暂不处理 / [r] 重新查看
└──────────────────────────────────────────────────┘

> y

┌─ 记忆召回确认 ───────────────────────────────────┐
│ 当前任务：#task_123 Phoenix 周报整理
│ 1. [project] Phoenix 周报统一保留风险栏目和经营数据栏目
│    判断依据：与当前输入语义相近
│ 请输入 [y] 全部采用 / [n] 全部忽略 / [s 编号...] 部分采用 / [a] 后续同类自动采用 / [r] 重新查看
└──────────────────────────────────────────────────┘

> y
→ 派发给 codex-cli...
```

相关命令：

- `/memory review-policy`
- `/memory review-policy revoke <id>`

### 学习闭环与 Skill 治理

Metaclaw 会从任务结果、失败、产物、材料和执行器 Skill 使用事件中生成 reflection，再沉淀为待审核学习候选。审核通过后，候选可以 promotion 成任务记忆卡、executor skill、skill patch、停用建议或废弃建议。

```bash
/learning candidates                  # 待审核学习候选
/learning approve <candidate_id> [备注]
/learning reject <candidate_id> [原因]
/learning promote <candidate_id>      # 下发成任务记忆卡 / Skill / Skill patch / 治理动作
/learning cards                       # 最近任务记忆卡
/learning skills                      # Skill Effect Summary
/learning summary                     # 学习资产概览
/learning weekly                      # 学习周报
```

学习资产会参与后续上下文召回：相关任务记忆卡会进入 recall review，只有用户确认后才会注入执行器上下文。

### 任务盘面

```bash
/dashboard          # 显示优先级排序、阻塞任务、建议
/attach [taskId] <文件路径...>  # 关联材料到当前任务或指定任务
/history            # 查看最近交互历史
/config             # 查看当前配置
/help               # 查看命令帮助
/exit               # 退出，也可用 /quit 或 /q
```

## 工作流程

### 完整执行流程

1. **用户输入自然语言** → 创建任务对象
2. **任务状态迁移** → CREATED → READY → RUNNING
3. **偏好召回** → 根据规则与 embedding 命中相关记忆
4. **Recall Review** → 把拟采用内容整理成可判断摘要卡
5. **用户确认** → `y / n / s / a / r`
6. **上下文注入** → 只把确认通过的记忆注入执行器
7. **调用默认执行器（Codex CLI）** → 通过 CLI 子进程执行
8. **结果回流** → 更新任务摘要、标记完成
9. **模式观察** → 提取重复模式，达到 3 次进入候选偏好确认
10. **主动提案** → 启动时、完成后或恢复场景生成下一步 proposal
11. **结果回流** → 文件产物会登记回任务对象并展示在任务视图中

### 偏好生命周期

```
用户输入包含模式
  ↓
observations 表记录（第 1 次）
  ↓
重复出现（第 2 次）
  ↓
达到阈值（第 3 次）→ 进入候选偏好确认
  ↓
用户通过 `y` / `e <新内容>` / `/memory confirm` 确认 → preferences 表（status=confirmed）
  ↓
后续任务命中后，先进入 recall review，再把确认通过的内容注入执行器
```

### 任务连续性

```
任务执行中 → 用户切换 → park（生成快照）
  ↓
快照保存：done/pending/nextStep/pauseReason
  ↓
恢复时 → 读取快照 → 生成恢复摘要
  ↓
继续执行 → 上下文无缝衔接
```

## 技术架构

```
src/
├── cli/            # CLI 参数解析：--script / --gateway / --connect
├── core/           # 核心引擎
│   ├── types.ts           # 类型定义
│   ├── task-engine.ts     # 任务状态机、快照、恢复
│   ├── memory-engine.ts   # 偏好观察、确认、召回
│   ├── context-recaller.ts # 任务、会话、时间线和相关历史召回
│   ├── embedding-provider.ts # 本地 embedding provider
│   ├── hybrid-memory-recaller.ts # 规则+语义混合召回
│   ├── recall-review-builder.ts  # recall review 决策摘要
│   ├── recall-policy-service.ts  # recall 自动采用策略判定
│   ├── reflection-engine.ts      # 执行结果反思与学习候选生成
│   ├── skill-governance-engine.ts # Skill 效果治理建议
│   ├── learning-weekly-review-builder.ts # 学习周报
│   └── orchestration.ts   # 优先级评分、盘面生成 / proposal 输出
├── storage/        # 数据层
│   ├── database.ts        # SQLite 初始化
│   ├── migrations.ts      # Schema 迁移
│   ├── task-repo.ts       # 任务数据访问
│   ├── preference-repo.ts # 偏好数据访问
│   ├── observation-repo.ts # 观察记录
│   ├── task-memory-card-repo.ts # 任务记忆卡
│   ├── learning-candidate-repo.ts # 学习候选审核
│   ├── skill-effect-summary-repo.ts # Skill 效果摘要
│   ├── task-memory-embedding-repo.ts # 任务 memory 向量
│   ├── preference-embedding-repo.ts  # 偏好向量
│   └── recall-review-policy-repo.ts  # recall 免确认策略
├── executor/       # 执行器适配
│   ├── adapter.ts         # 抽象接口
│   ├── codex-cli.ts       # Codex CLI 适配器（默认）
│   ├── claude-code.ts     # Claude Code CLI 适配器（兼容保留）
│   ├── prompt-builder.ts  # 执行上下文包构造
│   └── skill-package-builder.ts # Skill / Skill patch 下发包
├── commands/       # 命令系统
│   ├── router.ts          # 斜杠命令路由
│   ├── task-commands.ts   # 任务命令
│   ├── memory-commands.ts # 偏好命令
│   ├── learning-commands.ts # 学习候选、任务记忆卡、Skill 治理命令
│   └── global-commands.ts # 全局命令
├── gateway/        # 本地 Gateway server/client，多 terminal 连接协议
├── integrations/   # 飞书应用、Markdown preview
├── notifications/  # 飞书通知
├── session/        # 交互 session 与脚本化 session
├── tui/            # 终端界面
│   └── app.tsx            # ink 组件
└── utils/          # 工具
    ├── config.ts          # 配置加载
    ├── logger.ts          # 日志
    ├── paths.ts           # Metaclaw 本地目录解析
    └── id.ts              # ID 生成
```

核心数据存在 `~/.metaclaw/metaclaw.db`，主要包括：

- `tasks`、`interactions`、`session_state`
- `preferences`、`observations`、`preference_usage`
- `task_relations`、`task_memory_embeddings`、`preference_embeddings`
- `memory_recall_events`、`recall_review_policies`、`recall_feedback`
- `reflection_events`、`learning_candidates`
- executor skill 安装事件、skill 使用事件和 skill effect summary

## 配置

编辑 `~/.metaclaw/config.yaml`：

```yaml
version: 1

executor:
  command: codex           # 默认执行器；可改为 claude
  timeout: 300             # 空闲超时（秒）：长时间无 stdout/stderr 活动才视为异常
  max_duration: 3600       # 总时长上限（秒）：宽松兜底，避免任务无限挂住

orchestration:
  reminder_enabled: true   # 是否启用主动提醒
  reminder_throttle: 300   # 提醒最小间隔（秒）
  top_k_preferences: 5     # 偏好召回数量上限

ui:
  language: zh-CN          # 界面语言
  dashboard_on_start: true # 启动时显示盘面

notifications:
  feishu:
    enabled: false         # 开启后会把待确认偏好候选发送到飞书群机器人
    webhook_url: ""        # 飞书自定义机器人 webhook
    secret: ""             # 可选：飞书机器人签名密钥

integrations:
  feishu:
    enabled: false         # 开启飞书应用双向通信
    mode: websocket        # websocket 或 webhook
    app_id: ""             # 飞书应用 App ID，例如 cli_xxx
    app_secret_env: FEISHU_APP_SECRET # 推荐用环境变量保存 App Secret
    event_port: 8787       # 本地 callback HTTP 端口
    event_path: /feishu/events # 飞书事件订阅请求路径
    verification_token: "" # 可选：飞书事件订阅 Verification Token

  markdown_preview:
    enabled: true          # 本地 Markdown preview 服务
    host: 127.0.0.1
    port: 8790
    public_base_url: ""    # 可选：公网或反代后的访问地址
```

启动前需要在同一个 shell 里导出 App Secret：

```bash
export FEISHU_APP_SECRET="你的飞书应用 App Secret"
./metaclaw.sh start
```

飞书通知当前覆盖“待确认偏好候选”事件，包括高置信偏好识别和三次重复模式识别。
通知只做提醒，不会在飞书里直接确认偏好；确认仍需回到 Metaclaw 输入 `/memory confirm <id>` 或在 TUI 中输入 `y`。

如果要通过飞书和 Metaclaw 双向对话，使用 `integrations.feishu`。启动后 Metaclaw 会在本机监听 `event_port + event_path`，需要用内网穿透或公网反代把该地址配置到飞书应用的事件订阅 Request URL。
收到飞书文本消息后，Metaclaw 会按普通输入处理，并把新增输出回发到同一个飞书会话。

Markdown preview 默认监听 `http://127.0.0.1:8790`。如果需要通过公网或反向代理访问，配置 `public_base_url`。

## 开发

```bash
# 开发模式（监听文件变化）
npm run dev

# 脚本化用户流烟测
node dist/index.js --script /tmp/metaclaw-flow.txt

# 运行测试
npm test

# 类型检查
npm run lint

# 构建
npm run build
```

## 测试

```bash
npm test                # 运行所有测试
npm run test:watch      # 监听模式
```

试用案例见：

- `examples/e2e/README.md`
- `examples/trial-scenarios/README.md`
- `examples/trial-scenarios/scripts/`
- `examples/trial-scenarios/manual/`

当前自动化测试覆盖：
- 多任务调度、抢占、挂起恢复、阻塞解除
- 对话 vs 任务边界
- 偏好三次确认、inline `y/n/e` 确认、注入透明
- recall review、自动采用策略和 feedback loop
- 材料链路：文件、链接、网页抓取、材料摘要
- 高风险动作确认门控
- 任务产物回流与 `/task` 详情视图
- Gateway client/server 协议与多 session 行为
- Codex / Claude 执行器适配、prompt 构造、错误归因和中断处理
- Phase E 学习候选、任务记忆卡、Skill promotion、Skill patch、Skill 治理和周报
- 飞书通知、飞书应用集成和 Markdown preview

## 设计文档

- [PRD V2](docs/metaclaw-os_prd_v2.md) — 产品需求、场景、验收标准
- [技术设计 V1](docs/metaclaw-os_tech_design_v1.md) — 数据模型、状态机、执行器方案
- [TUI 规范 V1](docs/metaclaw-os_tui_spec_v1.md) — 交互规范、命令体系
- [实施方案 V1](docs/metaclaw-os_implementation_v1.md) — 技术栈、模块设计、分阶段路线
- [Phase E 统一学习与执行器 Skill 演进](docs/metaclaw-phase-e-unified-learning-and-executor-skill-evolution.md) — 反思、学习资产、Skill promotion 与治理

## 许可

MIT
