# Metaclaw

> An AGI-native enterprise workbench for task continuity, memory, and proactive agent orchestration.
> 面向企业服务场景的 AI 原生工作中枢，支持任务连续性、偏好记忆与主动智能体编排。

Metaclaw is a terminal-based agentic workbench for organizations and teams. It helps enterprise users keep complex work moving across interruptions, sessions, tools, and execution contexts.

Metaclaw 是一个面向组织与团队的终端智能体工作中枢，帮助企业用户在跨中断、跨会话、跨工具和跨执行上下文的复杂工作中保持连续推进。

## Why Metaclaw · 为什么需要 Metaclaw

Metaclaw focuses on three core capabilities:

1. **Continuity**: recover work after interruptions and preserve context across days and sessions.
2. **Memory**: capture stable user, team, and project preferences so people do not repeat the same instructions.
3. **Guidance**: proactively surface what should happen next, where work is blocked, and which task is most valuable to continue.

Metaclaw 专注三个核心能力：

1. **Continuity（连续性）**：任务被打断后能恢复，并跨天、跨会话保留上下文。
2. **Memory（记忆）**：沉淀用户、团队和项目偏好，减少重复说明。
3. **Guidance（引导）**：主动提示下一步、阻塞点，以及最值得继续推进的任务。

The current version includes:

- User-confirmed operation proposals instead of silent automation.
- Recall review before memory is injected into an executor context.
- Local Gateway support, so multiple terminals can connect to one Metaclaw instance.
- A learning loop for task memory cards, skill candidates, skill patches, governance, and weekly reviews.
- Feishu notification/app integrations and local Markdown preview.

当前版本包括：

- 需要用户确认的操作提案，而不是静默自动化。
- 记忆注入执行器前先进行 recall review。
- 本地 Gateway，多 terminal 可连接同一个 Metaclaw 实例。
- 任务记忆卡、Skill 候选、Skill patch、治理和周报组成的学习闭环。
- 飞书通知/应用集成，以及本地 Markdown preview。

## Quick Start · 快速开始

### Requirements · 环境要求

Metaclaw requires Node.js `>=20`. The default executor is `codex`; `claude` remains available as a compatible executor option.

Metaclaw 需要 Node.js `>=20`。默认执行器是 `codex`，同时保留 `claude` 兼容入口。

### Install · 安装

```bash
npm install
npm run build
npm link
```

### Run · 运行

```bash
metaclaw
```

You can also start Metaclaw with the project helper script:

```bash
./metaclaw.sh start
```

On first launch, Metaclaw creates its config and database under `~/.metaclaw/`.

首次启动时，Metaclaw 会在 `~/.metaclaw/` 下创建配置和数据库。

### Connect To A Running Instance · 连接已运行实例

If one terminal is already running Metaclaw, do not start a second full instance. Connect to the existing instance through the local Gateway:

```bash
./metaclaw.sh connect
```

Each connected terminal gets an independent `session_id`. Tasks, memory, and executor infrastructure are shared, but recent conversation context is isolated per session.

每个连接的 terminal 都有独立的 `session_id`。任务、记忆和执行器底座共享，但每个会话的近期对话上下文彼此隔离。

### Status And Logs · 状态与日志

```bash
./metaclaw.sh status
./metaclaw.sh logs
./metaclaw.sh logs -f
./metaclaw.sh stop
./metaclaw.sh restart
```

`metaclaw.sh` checks whether the source is newer than `dist/index.js`; if needed, it runs `npm run build` before startup.

`metaclaw.sh` 会检查源码是否比 `dist/index.js` 更新；如果需要，会在启动前自动执行 `npm run build`。

The CLI can also run or connect to the Gateway directly:

```bash
metaclaw --gateway
metaclaw --connect
```

### Scripted Smoke Test · 脚本化烟测

```bash
cat > /tmp/metaclaw-flow.txt <<'EOF'
Compare the risk points across three contracts and produce a concise table.
/tasks done
EOF

metaclaw --script /tmp/metaclaw-flow.txt
```

`--script` executes input line by line. Blank lines and lines starting with `#` are ignored.

`--script` 会按行执行输入脚本。空行和以 `#` 开头的注释会被忽略。

## Core Capabilities · 核心能力

### Task Management And Execution · 任务管理与执行

Create tasks in natural language, execute them through the configured executor, and continue follow-up work in the same task context.

你可以用自然语言创建任务，通过配置的执行器执行，并在同一任务上下文中继续 follow-up 工作。

```bash
> Compare three contracts and create a risk matrix.
→ Task #task_abc123 created: Compare three contracts and create a risk matrix.
→ Dispatching to codex-cli...
→ Running task #task_abc123...
· #task_abc123 started codex-cli executor
· Waiting for executor output...
✓ Task completed (12.3s)

┌─ Task Result ────────────────────────────────────┐
│ Summary: [result summary...]
│ Next step: continue from this result if needed
└──────────────────────────────────────────────────┘

[executor output...]

> Continue and export the table to Excel.
→ Running task #task_abc123...
✓ Task completed (5.2s)
```

Task commands:

```bash
/tasks              # All tasks
/tasks active       # Active tasks
/tasks ready        # Ready tasks
/tasks parked       # Parked tasks
/tasks blocked      # Blocked tasks
/tasks done         # Completed tasks

/task <id>          # Show task detail
/task <id> pause    # Pause a task
/task <id> resume   # Resume a task
/task <id> block waiting for customer data
/task <id> unblock
/task <id> unblock /tmp/evidence-v3.pdf
/task <id> cancel
/task <id> done
```

The task detail view shows result summaries, local file materials, web link materials, material status, and task artifacts.

任务详情会展示结果摘要、本地文件材料、网页链接材料、材料状态和任务产物。

### TUI Experience · 终端界面

```text
Running 1 | Ready 0 | Parked 0 | Blocked 0
Latest event Started task #task_abc123

status: running codex-cli
>
```

The interface separates user input, routing, execution progress, waiting states, and task result blocks.

界面会区分用户输入、系统路由、执行进度、等待状态和任务结果块。

### Memory And Preference Extraction · 记忆与偏好提取

Metaclaw observes repeated patterns and asks before saving long-term preferences.

Metaclaw 会观察重复模式，并在保存长期偏好前请求用户确认。

```bash
> Draft a formal update for Alex about the project risk.
[execution...]

> Draft a formal update for Jamie about the project risk.
[execution...]

> Draft a formal update for Taylor about the project risk.
[execution...]
💡 Repeated pattern detected: "formal tone"
   Save this as a long-term preference?
   [y] confirm  [n] ignore  [e <new content>] edit and confirm
```

Memory commands:

```bash
/memory
/memory candidates
/memory confirm obs_123 --scope contact --subject Alex
/memory add Alex prefers formal updates with legal copied
/memory add --scope contact --subject Alex Alex prefers formal updates with legal copied
/memory search formal
/memory edit <pref_id> --scope project Use tables for outputs
/memory delete <pref_id>
/memory stats
```

### Materials And Artifacts · 材料与产物

Attach files and links directly in natural language. Metaclaw tracks materials and records generated artifacts back to the task.

可以在自然语言中直接附带文件和链接。Metaclaw 会跟踪材料，并把生成的产物回写到任务对象。

```bash
> Use ./weekly.md and https://example.com/report to prepare the Phoenix weekly report.

> Save the analysis as a markdown file.

> /task <id>
Artifacts: /abs/path/to/output.md
```

### Risky Action Gate · 高风险动作门控

High-risk actions require explicit confirmation before execution.

高风险动作必须明确确认后才会执行。

```bash
> Send the email directly to the customer.
⚠️ This is a high-risk action and will not run by default.
→ Type "confirm execution" to continue, or "cancel execution" to stop.

> confirm execution
→ High-risk action confirmed. Continuing.
```

### Proposals And Recall Review · 操作提案与记忆召回确认

Metaclaw does not silently apply important context. It shows proposals and memory recall cards before acting.

Metaclaw 不会静默采用重要上下文，而是在行动前展示操作提案和记忆召回卡。

```text
┌─ Operation Proposal ─────────────────────────────┐
│ Scenario: startup suggestion
│ Action: resume task #task_123: Phoenix weekly report
│ Reason: 80% complete; continuing is cheaper than restarting
│ Enter [y] accept / [n] skip / [r] review again
└──────────────────────────────────────────────────┘

> y

┌─ Memory Recall Review ───────────────────────────┐
│ Current task: #task_123 Phoenix weekly report
│ 1. [project] Phoenix weekly reports keep risk and operating metrics sections.
│    Reason: semantically close to current input
│ Enter [y] use all / [n] ignore all / [s numbers...] use selected / [a] auto-use similar recalls later / [r] review again
└──────────────────────────────────────────────────┘
```

Related commands:

```bash
/memory review-policy
/memory review-policy revoke <id>
```

### Learning Loop And Skill Governance · 学习闭环与 Skill 治理

Metaclaw can turn execution results, failures, artifacts, materials, and executor skill usage events into reflections and reviewable learning candidates. Approved candidates can become task memory cards, executor skills, skill patches, disable suggestions, or deprecation suggestions.

Metaclaw 可以从执行结果、失败、产物、材料和执行器 Skill 使用事件中生成 reflection，并沉淀为待审核学习候选。审核通过后，候选可以变成任务记忆卡、executor skill、skill patch、停用建议或废弃建议。

```bash
/learning candidates                  # Review pending learning candidates
/learning approve <candidate_id> [note]
/learning reject <candidate_id> [reason]
/learning promote <candidate_id>      # Promote into memory / skill / patch / governance action
/learning cards                       # Recent task memory cards
/learning skills                      # Skill effect summary
/learning summary                     # Learning asset overview
/learning weekly                      # Weekly learning review
```

Learning assets participate in future recall review. They are injected into executor context only after user confirmation.

学习资产会参与后续召回；只有用户确认后才会注入执行器上下文。

### Dashboard · 任务盘面

```bash
/dashboard                         # Priorities, blocked tasks, and suggestions
/attach [taskId] <file paths...>    # Attach materials to current or specified task
/history                           # Recent interaction history
/config                            # Current configuration
/help                              # Command help
/exit                              # Exit; /quit and /q also work
```

## Workflow · 工作流程

### Execution Flow · 执行流程

1. User enters natural language.
2. Metaclaw creates or routes to a task object.
3. Task state moves through `CREATED -> READY -> RUNNING`.
4. Relevant memory is recalled through rules and embeddings.
5. Recall review summarizes candidate context for user confirmation.
6. Confirmed context is injected into the executor prompt.
7. The configured executor runs the task.
8. Results update task summaries, artifacts, and status.
9. Repeated patterns become preference candidates.
10. Proposals suggest what to continue next.

Chinese flow summary:

1. 用户输入自然语言。
2. Metaclaw 创建任务对象或路由到已有任务。
3. 任务状态经过 `CREATED -> READY -> RUNNING`。
4. 通过规则和 embedding 召回相关记忆。
5. Recall review 把候选上下文整理成可判断摘要。
6. 用户确认后的上下文才会注入执行器 prompt。
7. 配置的执行器执行任务。
8. 结果回写任务摘要、产物和状态。
9. 重复模式沉淀为偏好候选。
10. 操作提案提示下一步最值得继续的工作。

### Preference Lifecycle · 偏好生命周期

```text
User input contains a repeated pattern
  ↓
Observation is recorded
  ↓
Pattern repeats
  ↓
Threshold is reached
  ↓
User confirms with y / e <new content> / /memory confirm
  ↓
Preference is saved as confirmed
  ↓
Future matches enter recall review before executor injection
```

### Task Continuity · 任务连续性

```text
Task running
  ↓
User switches context
  ↓
Task is parked with a snapshot
  ↓
Snapshot stores done / pending / nextStep / pauseReason
  ↓
Resume reads the snapshot and rebuilds context
  ↓
Execution continues without losing task state
```

## Architecture · 技术架构

```text
src/
├── cli/            # CLI args: --script / --gateway / --connect
├── core/           # Task, memory, recall, reflection, orchestration engines
├── storage/        # SQLite database, migrations, repositories
├── executor/       # Codex and Claude executor adapters, prompt builders, skill packages
├── commands/       # Slash command router and command handlers
├── gateway/        # Local Gateway server/client for multi-terminal sessions
├── integrations/   # Feishu app integration and Markdown preview
├── notifications/  # Feishu notifications
├── session/        # Interactive and scripted sessions
├── tui/            # Ink-based terminal UI
└── utils/          # Config, paths, logger, IDs
```

Core data lives in `~/.metaclaw/metaclaw.db`, including tasks, interactions, session state, preferences, observations, recall events, learning candidates, reflection events, task memory cards, skill usage events, and governance summaries.

核心数据存储在 `~/.metaclaw/metaclaw.db`，包括任务、交互、会话状态、偏好、观察记录、召回事件、学习候选、reflection、任务记忆卡、Skill 使用事件和治理摘要。

## Configuration · 配置

Edit `~/.metaclaw/config.yaml`:

```yaml
version: 1

executor:
  command: codex           # Default executor; can be changed to claude
  timeout: 300             # Idle timeout in seconds
  max_duration: 3600       # Total execution cap in seconds

orchestration:
  reminder_enabled: true   # Enable proactive reminders
  reminder_throttle: 300   # Minimum reminder interval in seconds
  top_k_preferences: 5     # Max recalled preferences

ui:
  language: zh-CN          # UI language
  dashboard_on_start: true # Show dashboard on startup

notifications:
  feishu:
    enabled: false
    webhook_url: ""
    secret: ""

integrations:
  feishu:
    enabled: false
    mode: websocket
    app_id: ""
    app_secret_env: FEISHU_APP_SECRET
    event_port: 8787
    event_path: /feishu/events
    verification_token: ""

  markdown_preview:
    enabled: true
    host: 127.0.0.1
    port: 8790
    public_base_url: ""
```

Before using the Feishu app integration, export the app secret in the same shell:

```bash
export FEISHU_APP_SECRET="your Feishu app secret"
./metaclaw.sh start
```

Feishu notifications currently cover pending preference candidates, including high-confidence preference detection and repeated-pattern detection. Notifications are reminders only; confirmation still happens in Metaclaw.

飞书通知当前覆盖待确认偏好候选，包括高置信偏好识别和重复模式识别。通知只做提醒，确认仍需回到 Metaclaw。

For two-way Feishu chat, enable `integrations.feishu` and expose `event_port + event_path` through a public reverse proxy or tunnel, then configure that URL in Feishu event subscriptions.

如果要通过飞书双向对话，启用 `integrations.feishu`，并通过公网反代或内网穿透暴露 `event_port + event_path`，再配置到飞书事件订阅中。

Markdown preview listens on `http://127.0.0.1:8790` by default. Configure `public_base_url` when using a public reverse proxy.

Markdown preview 默认监听 `http://127.0.0.1:8790`。如需公网访问，请配置 `public_base_url`。

## Development · 开发

```bash
npm run dev
node dist/index.js --script /tmp/metaclaw-flow.txt
npm test
npm run lint
npm run build
```

## Testing · 测试

```bash
npm test
npm run test:watch
```

Scenario packages:

- `examples/e2e/README.md`
- `examples/trial-scenarios/README.md`
- `examples/trial-scenarios/scripts/`
- `examples/trial-scenarios/manual/`

Current automated coverage includes:

- Multi-task scheduling, preemption, parking, resume, and unblock flows.
- Conversation-vs-task boundaries.
- Preference confirmation, inline `y/n/e`, and transparent context injection.
- Recall review, auto-use policy, and feedback loops.
- Materials: files, links, web fetch, and material summaries.
- High-risk action confirmation gates.
- Task artifact tracking and `/task` detail views.
- Gateway client/server protocol and multi-session behavior.
- Codex / Claude executor adapters, prompt construction, error attribution, and interruptions.
- Phase E learning candidates, task memory cards, skill promotion, skill patches, governance, and weekly reviews.
- Feishu notifications, Feishu app integration, and Markdown preview.

Chinese coverage summary:

- 多任务调度、抢占、挂起恢复和阻塞解除。
- 对话与任务边界。
- 偏好确认、inline `y/n/e` 和上下文透明注入。
- Recall review、自动采用策略和 feedback loop。
- 文件、链接、网页抓取和材料摘要。
- 高风险动作确认门控。
- 任务产物回流和 `/task` 详情视图。
- Gateway client/server 协议和多 session 行为。
- Codex / Claude 执行器适配、prompt 构造、错误归因和中断处理。
- Phase E 学习候选、任务记忆卡、Skill promotion、Skill patch、治理和周报。
- 飞书通知、飞书应用集成和 Markdown preview。

## Design Documents · 设计文档

- [PRD V2](docs/metaclaw-os_prd_v2.md): product requirements, scenarios, and acceptance criteria.
- [Technical Design V1](docs/metaclaw-os_tech_design_v1.md): data model, state machine, and executor design.
- [TUI Spec V1](docs/metaclaw-os_tui_spec_v1.md): interaction model and command system.
- [Implementation Plan V1](docs/metaclaw-os_implementation_v1.md): stack, modules, and staged roadmap.
- [Phase E Learning And Executor Skill Evolution](docs/metaclaw-phase-e-unified-learning-and-executor-skill-evolution.md): reflection, learning assets, skill promotion, and governance.

## License · 许可

MIT
