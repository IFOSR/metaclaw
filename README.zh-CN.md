# MetaClaw

[English](README.md) | [中文](README.zh-CN.md)

MetaClaw 是一个面向长周期知识工作的智能体操作系统。它把任务、记忆、执行器路由、飞书交付和文件产物放在一个可审计的本地系统里。

它适合需要 AI Agent 跨中断持续工作的团队：任务可以恢复，明确适用的记忆可以自动注入，工作可以路由到合适的执行器，最终结果可以回到飞书和在线预览里。

## 核心能力

- 持久任务状态：created、ready、running、parked、blocked、done、archived、cancelled。
- 中断后通过 resume context 继续，不从头重做。
- 系统空闲时自动恢复满足条件的挂起任务。
- 用语义优先级判断紧急任务，不靠关键词匹配。
- 按任务意图和执行器边界自动路由。
- 只自动注入明确适用的记忆和偏好；不确定召回默认跳过，飞书和无人值守执行器不会等待确认。
- 生成文件自动记录为任务产物。
- 飞书回复、文件同步和 Markdown 在线预览由后端统一处理。
- 本地 Gateway 支持多个终端连接同一个 MetaClaw runtime。

## 核心架构

MetaClaw 是面向任务的系统，而不是纯 session agent。普通 agent session 主要回答当前这一轮。MetaClaw 会判断用户输入应该保持为轻量对话、控制已有任务，还是变成一个可以调度、阻塞、恢复、检索和审计的持久任务。

```text
User Input
    │
    ▼
Input Boundary
    ├── conversation
    ├── task_control
    └── durable_task
          │
          ▼
Task Runtime
    ├── TaskEngine: 任务状态机
    ├── SchedulerEngine: 队列、优先级、抢占、恢复
    ├── OrchestrationEngine: 盘面、建议、blocked/parked 巡检
    ├── MemoryEngine: 偏好、任务记忆、召回审查
    └── MetaclawSession: TUI/script/gateway runtime 协调层
          │
          ▼
Execution Layer
    ├── ExecutorRouter: 按意图选择 executor
    ├── Executor adapters: Codex、Pi、Hermes、自定义 CLI
    └── Backend delivery: 飞书、文件产物、Markdown 预览
```

conversation / task 的边界很重要：

- Conversation：即时回答，不创建持久任务。适合解释、澄清、状态问答。
- Task control：查看或改变已有任务状态。适合“当前在跑什么”“继续那个任务”“清空阻塞任务”。
- Durable task：创建或继续需要执行、持久化、产物、恢复、调度或后续检索的工作。

当前下一轮架构主线记录在 [MetaClaw Task OS 架构与策略升级方案](docs/plans/2026-06-14-metaclaw-task-os-architecture-strategy-upgrade.md)。本轮优先做任务检索索引、混合任务召回、执行策略规划、多执行器 work units，以及汇总/验证。本轮明确不优先做 Executor Discovery、远程 Registry 或大规模多客户端 Gateway 扩展。

## 当前执行器

| 执行器 | 命令 | 适合任务 | 安装要求 |
| --- | --- | --- | --- |
| Codex CLI | `codex` | 仓库修改、测试、确定性实现、带 patch 的代码审查 | 安装并登录 OpenAI Codex CLI |
| Pi Agent | `pi` | 调研、报告生成、多步骤信息综合、agentic CLI 工作流 | 安装 `@earendil-works/pi-coding-agent` 并完成登录 |
| Hermes Agent | `hermes` | 调研、多工具编排、记忆/网关/助手工作流 | 安装并登录 Hermes |

默认执行器是 `codex`。默认路由会把仓库工作交给 `codex-cli`。调研任务可以同时派发给 Pi Agent 和 Hermes Agent，谁先返回就采用谁的结果，并终止另一个较慢的 executor。DeepSeek TUI adapter 仍保留为兼容/手动配置能力，但已经从默认 Executor 注册表和自动路由候选中 retire。

## 前提条件

必须具备：

- Node.js `>=20.0.0`。
- npm。
- Git。
- Unix-like shell 环境，优先支持 macOS 和 Linux。
- `better-sqlite3` 的原生编译工具链。

推荐安装编译工具：

```bash
# macOS
xcode-select --install

# Ubuntu / Debian
sudo apt-get update
sudo apt-get install -y build-essential python3 make g++
```

执行器前提：

- 使用默认 `codex-cli`：安装并登录 OpenAI Codex CLI。
- 使用调研并行竞速：安装并登录 Pi Agent 和 Hermes Agent。

飞书集成前提：

- 飞书应用具备消息接收和发送权限。
- 将 app secret 放入环境变量，例如 `FEISHU_APP_SECRET`。
- 使用双向飞书对话时，订阅 `im.message.receive_v1`。
- 如需回传文件，开启文件上传和发送消息能力。
- 如果飞书需要访问本地事件接口或 Markdown 预览服务，需要公网反代或内网穿透。

Markdown 在线预览前提：

- `integrations.markdown_preview.enabled: true`。
- 如果用户不在宿主机上打开链接，需要配置可访问的 `public_base_url`。

## 安装

推荐使用一键 setup：

```bash
git clone https://github.com/IFOSR/metaclaw.git
cd metaclaw
./setup.sh
```

`setup.sh` 会安装 MetaClaw 本身、构建 CLI、执行 `npm link`、生成 `~/.metaclaw/config.yaml`，并自动检测当前系统里的 Executor。

在交互式终端里，它会展示检测到的 Executor 列表，让用户选择要接入哪几个 Executor，并选择哪个作为默认 Executor。如果选择了缺失但支持自动安装的 Executor，setup 可以直接安装。没有任何 Executor 可用时，默认 fallback 是安装 Codex CLI：

```bash
npm install -g @openai/codex
```

setup 可选参数：

```bash
# 默认不覆盖已有 ~/.metaclaw/config.yaml
METACLAW_OVERWRITE_CONFIG=false ./setup.sh

# 强制重写 ~/.metaclaw/config.yaml
METACLAW_OVERWRITE_CONFIG=true ./setup.sh

# 只构建，不执行 npm link
METACLAW_INSTALL_MODE=none ./setup.sh

# 没有 Executor 时也不自动安装 Codex CLI
METACLAW_INSTALL_CODEX=false ./setup.sh

# 强制使用非交互默认行为
METACLAW_SETUP_INTERACTIVE=false ./setup.sh
```

手动安装 fallback：

```bash
npm install
npm run build
npm link
```

检查 CLI：

```bash
metaclaw --help
```

## 安装执行器

MetaClaw 不内置下游执行器 CLI。你需要自己安装要使用的执行器，并确保命令在 `PATH` 中。

### 注册自定义 Executor

Executor 是 MetaClaw 可以路由任务的运行时工人。一个已注册 Executor 现在包含两层信息：

- 路由画像：适用领域、能力、风险等级、历史成功率、输入/输出类型和适用场景。
- 运行绑定：本机命令、非交互参数、安装检测命令和可选项目地址。

如果不确定具体该填什么，使用问答式注册向导：

```bash
/executor register wizard
```

向导会依次询问 Executor 名称、是否从项目地址推断、运行命令、非交互参数、安装检测命令、适用领域和能力。如果提供 GitHub 项目地址，MetaClaw 会尝试从 `package.json` 或 README 示例推断 CLI 信息；如果无法可靠推断，会自动回到手动填写。

也可以一次性注册：

```bash
/executor register research-bot \
  --command research-bot \
  --args "run --prompt {prompt}" \
  --check "research-bot --version" \
  --project-url https://github.com/example/research-bot \
  --domains research,reporting \
  --capabilities research,report_generation
```

`{prompt}` 会被替换为任务提示词。如果 `--args` 不包含 `{prompt}`，MetaClaw 会把 prompt 追加为最后一个参数。调度到自定义 Executor 前，MetaClaw 会先执行配置的检测命令；检测失败时会把该 Executor 标记为 `unavailable`，并回退默认 Executor。

Executor 扩展契约：

必需的路由字段：

- `name`：稳定的 Executor 名称，例如 `research-bot` 或 `finance-research-agent`。
- `domains`：适用领域，例如 `research`、`finance`、`software`。
- `capabilities`：能力标签，例如 `research`、`report_generation`、`multi_tool`、`coding`、`tests`。
- `availability`：`available` 或 `unavailable`；安装检测失败时 MetaClaw 会更新该状态。

建议的路由字段：

- `inputTypes`：支持输入类型，例如 `text`、`files`、`image`。
- `outputTypes`：输出类型，例如 `markdown`、`report`、`code`、`patch`、`json`。
- `primaryUseCases`：适合路由给它的典型任务。
- `avoidUseCases`：不适合路由给它的任务。
- `riskLevel`：`low`、`medium` 或 `high`。
- `historicalSuccess`：历史成功分数，后续可随任务结果影响排序。
- `projectUrl`：项目仓库或文档地址。

必需的运行绑定：

- `runtimeCommand`：本机 `PATH` 上可执行的命令，例如 `research-bot`。
- `runtimeArgs`：非交互运行参数，例如 `["run", "--prompt", "{prompt}"]`。
- `runtimeCheckCommand`：安装或可用性检测命令，例如 `research-bot --version`。

运行行为要求：

- 必须能非交互运行，不能等待人工输入。
- 必须能通过 `{prompt}` 或最后一个参数接收完整任务提示词。
- 最终答案应输出到 stdout。
- 失败时应返回非 0 exit code，或在 stderr 输出明确错误。
- 长任务应周期性输出进度，避免被 idle watchdog 判断为卡死。
- 文件产物应写入 prompt 中指定的任务输出目录。
- 飞书交付、文件上传和预览链接生成应由 MetaClaw 后端完成；Executor 应产出本地文件，不应自己直接调用飞书 API。

可选高级 Adapter 接口：

- `execute(input)`：用结构化上下文执行任务。
- `isAvailable()`：检测 Executor 是否可运行。
- `abort()`：取消正在执行的任务。
- `installSkill(pkg)`、`updateSkill(pkg)`、`disableSkill(target)`、`deprecateSkill(target)`：支持 Executor 自己的 Skill 生命周期管理。

常用管理命令：

```bash
/executor list
/executor register wizard
/executor unregister <name>
/executor route <任务描述>
/executor route-feedback
```

### Codex CLI

安装并登录 Codex CLI 后验证：

```bash
which codex
codex --help
```

默认配置：

```yaml
executor:
  command: codex
  timeout: 300
  max_duration: 3600
```

`timeout` 表示连续无输出 watchdog，不是固定墙钟总时长限制。只要 executor 仍在 stdout 或 stderr 输出内容，MetaClaw 就会续期，不会因为运行时间长而杀掉仍活跃的进程。`max_duration` 仅保留用于兼容旧配置，不再用于终止活跃 executor。

### Pi Agent

```bash
npm install -g @earendil-works/pi-coding-agent
which pi
pi --help
```

MetaClaw 调用方式：

```bash
pi -p "<prompt>"
```

Pi 调研类工作流通常比 CLI 编码任务执行更久。即使全局执行器配置更短，MetaClaw 也会自动给 `pi-agent` 至少 `timeout: 900` 秒的连续无输出等待时间。活跃的 Pi 进程不会再因为硬总时长上限被终止。

### Hermes Agent

```bash
which hermes
hermes --help
```

MetaClaw 调用方式：

```bash
hermes --oneshot "<prompt>" --yolo --accept-hooks
```

`--oneshot` 让 Hermes 以脚本/headless 模式运行，`--yolo` 跳过危险命令确认，`--accept-hooks` 自动接受未见过的 hooks。调研任务可以并行启动 Pi Agent 和 Hermes Agent；MetaClaw 记录先返回的结果，并中止另一个 executor。

### 已退役的兼容 Adapter

`deepseek-tui`、`claude-code` 和 `openclaw` adapter 仍保留在代码里，用于兼容和显式本地配置；但除非把它们显式配置为默认 executor，否则不会进入默认注册表。

## Executor 与 Skill 的差异

Executor 和 Skill 是生态里的不同层。

Executor 是“谁来干活”。Skill 是“干活时带什么方法、知识和工具规范”。

Executor 更像一个可派发的 Agent runtime：Codex CLI、Pi Agent、Hermes Agent、DeepSeek TUI，或者某个垂直领域本地 Agent。它决定模型、工具链、权限、运行环境、上下文窗口、文件读写能力、非交互执行方式、成本和可靠性边界。

Skill 更像轻量能力包。它描述某一类工作应该怎么做：怎么做期货分析、怎么做代码审查、怎么跑调研流程、怎么输出报告格式。Skill 可以改善某个 Executor 的表现，但不会自动改变这个 Executor 的 runtime、权限、工具或安装状态。

Executor 的优势：

- 增加新的 runtime 边界，包括模型、工具、凭证、权限和命令行行为。
- 让 MetaClaw 可以把任务路由给最适合的执行者。
- 支持不同 Agent 之间的回退、竞速、交叉验证和审计。
- 可以接入通用 Skill 无法访问的私有系统或垂直领域系统。

Executor 的代价：

- 安装和配置更重。
- 必须明确非交互运行命令和可用性检测方式。
- 需要处理权限、超时、失败和回退。
- 多个 runtime 行为不一致时，会增加运维复杂度。

Skill 的优势：

- 更轻量，添加速度快。
- 适合沉淀可重复的方法、清单、领域启发和输出规范。
- 能提高同一个 Executor 在特定任务上的一致性。
- 运维成本比新增 runtime 更低。

Skill 的限制：

- 受限于宿主 Executor 的工具、权限、上下文和模型。
- 不能凭空获得不存在的 CLI、私有 API、浏览器能力、文件权限或企业系统集成。
- 通常提升执行质量，而不是扩展 runtime 边界。

当缺失能力来自“需要不同工人或不同 runtime”时，MetaClaw 通过注册 Executor 扩展能力；当已有工人需要更好的流程、领域知识或输出规范时，通过 Skill 扩展能力。

## 运行

```bash
metaclaw
```

或使用项目脚本：

```bash
./metaclaw.sh start
```

首次启动会创建：

```text
~/.metaclaw/
├── config.yaml
├── metaclaw.db
└── gateway.sock
```

连接已有实例：

```bash
./metaclaw.sh connect
```

运行管理：

```bash
./metaclaw.sh status
./metaclaw.sh logs
./metaclaw.sh logs -f
./metaclaw.sh restart
./metaclaw.sh stop
```

安装或管理用户级 Gateway 服务：

```bash
./metaclaw.sh gateway install
./metaclaw.sh gateway start
./metaclaw.sh gateway status
./metaclaw.sh gateway restart
./metaclaw.sh gateway stop
```

直接 Gateway 模式：

```bash
metaclaw --gateway
metaclaw --connect
```

## 配置

编辑：

```bash
~/.metaclaw/config.yaml
```

示例：

```yaml
version: 1

executor:
  command: codex
  timeout: 300
  max_duration: 3600

orchestration:
  reminder_enabled: true
  reminder_throttle: 300
  top_k_preferences: 5
  blocked_recheck_enabled: true
  blocked_recheck_interval: 60

ui:
  language: zh-CN
  dashboard_on_start: true

notifications:
  feishu:
    enabled: false
    webhook_url: ""
    secret: ""

gateway:
  enabled: true
  platforms:
    feishu:
      enabled: true
      domain: feishu
      connection_mode: websocket
      app_id: ""
      app_secret_env: FEISHU_APP_SECRET
      event_port: 8787
      event_path: /feishu/events
      verification_token: ""
      encrypt_key_env: FEISHU_ENCRYPT_KEY
      home_channel: ""
      access:
        dm_policy: pairing
        allowed_users: []
        group_policy: open
        require_mention: true
      delivery:
        final_markdown_mode: card
        fallback_mode: post
        final_file_fallback: true

integrations:
  markdown_preview:
    enabled: true
    host: 127.0.0.1
    port: 8790
    public_base_url: ""
```

启动前导出飞书密钥：

```bash
export FEISHU_APP_SECRET="your Feishu app secret"
./metaclaw.sh start
```

## 飞书交付和在线预览

MetaClaw 将“文档生成”和“飞书交付”分开处理：

- 执行器只负责把 Markdown 或其他文件写入任务输出目录。
- MetaClaw 将文件记录为 task artifacts。
- 飞书后端把最终答案发回聊天。
- 如果文件上传能力可用，飞书后端会上传任务产物。
- 如果配置了 Markdown Preview，Markdown 产物会附带在线预览链接。
- 投递尝试会写入 `~/.metaclaw/gateway-audit.jsonl`。

执行器不应该直接调用飞书云文档 API。用户说“飞书云文档”或“在线预览”时，MetaClaw 会要求执行器产出本地 Markdown 产物，后端负责飞书同步和预览链接。

飞书进度卡片会明确展示执行链路。MetaClaw 会先把请求发送给 `codex-cli` 做意图解析和执行准备，然后展示路由决策、路由原因，以及真正启动任务的执行器。调研工作流会展示 `pi-agent + hermes-agent` 竞速：先返回的结果被采用，较慢的 executor 被中止。这样飞书用户不会把意图解析器误认为最终执行器。

最终飞书回复优先使用 Markdown message card。长回复会拆成多张卡片；如果某个卡片 chunk 失败，MetaClaw 会把该 chunk 重试为富文本 post；如果仍有 chunk 无法投递，会上传完整最终答案 Markdown 文件，避免用户只收到半截结果。

访问控制由 Gateway 处理：

- 私聊默认使用 `dm_policy: pairing`。第一个私聊用户会自动通过，后续用户可用 `metaclaw gateway pairing` 审批或撤销。
- 群聊默认使用 `group_policy: open` 和 `require_mention: true`。
- 在飞书聊天里发送 `/sethome` 会把该聊天记录为 `gateway.platforms.feishu.home_channel`。
- 旧版 `integrations.feishu` 配置仍会作为兼容来源读取，但新部署应使用 `gateway.platforms.feishu`。

常用飞书 Gateway 命令：

```bash
metaclaw gateway doctor
metaclaw gateway pairing list
metaclaw gateway pairing approve <open_id>
metaclaw gateway pairing revoke <open_id>
```

默认预览 URL：

```text
http://127.0.0.1:8790/preview/<artifact>
```

如果飞书用户不在宿主机上打开链接，需要暴露 preview 服务并设置：

```yaml
integrations:
  markdown_preview:
    enabled: true
    host: 127.0.0.1
    port: 8790
    public_base_url: https://preview.example.com
```

## 常用命令

```bash
/tasks
/tasks active
/tasks ready
/tasks parked
/tasks blocked
/tasks done

/task <id>
/task <id> pause
/task <id> resume
/task <id> block waiting for customer data
/task <id> unblock
/task <id> unblock /tmp/evidence-v3.pdf
/task <id> cancel
/task <id> done

/dashboard
/attach [taskId] <file paths...>
/history
/config
/help
/exit
```

## 调度和路由

- 任务优先级由紧急度、准备度、连续性收益、下游影响和搁置时间组成。
- 紧急度来自结构化语义判断，不靠关键词。
- 满足条件的 parked 任务会在系统空闲时自动恢复。
- 语义紧急的 parked 任务会排在普通 parked 任务前面。
- 任务池看护会周期性展示 blocked / parked 任务，以及缺失条件或下一步。
- 可恢复的执行器故障会被定时复查；执行器恢复可用后，任务会重新进入调度。
- 材料、权限、授权和访问类阻塞不会自动解除，必须等用户补充输入或显式 unblock。
- 未 ready 的任务不会自动执行。

路由按意图优先：

- `repo_execution` 默认走 `codex-cli`。
- `research_workflow` 可以同时派发给 `pi-agent` 和 `hermes-agent`；先返回者胜出，另一个 executor 会被中止。
- `memory_agent_ops` 优先走 `pi-agent`，不可用时回退默认执行器。
- 用户显式指定执行器时优先尊重。

## 开发

```bash
npm run dev
npm run build
npm test
npm run lint
```

脚本化烟测：

```bash
cat > /tmp/metaclaw-flow.txt <<'EOF'
Compare the risk points across three contracts and produce a concise table.
/tasks done
EOF

metaclaw --script /tmp/metaclaw-flow.txt
```

## 目录结构

```text
src/
├── cli/
├── commands/
├── core/
├── executor/
├── gateway/
├── integrations/
├── notifications/
├── session/
├── storage/
├── tui/
└── utils/
```

## License

MIT
