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

```bash
git clone https://github.com/IFOSR/metaclaw.git
cd metaclaw
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

ui:
  language: zh-CN
  dashboard_on_start: true

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

执行器不应该直接调用飞书云文档 API。用户说“飞书云文档”或“在线预览”时，MetaClaw 会要求执行器产出本地 Markdown 产物，后端负责飞书同步和预览链接。

飞书进度卡片会明确展示执行链路。MetaClaw 会先把请求发送给 `codex-cli` 做意图解析和执行准备，然后展示路由决策、路由原因，以及真正启动任务的执行器。调研工作流会展示 `pi-agent + hermes-agent` 竞速：先返回的结果被采用，较慢的 executor 被中止。这样飞书用户不会把意图解析器误认为最终执行器。

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
- blocked 或未 ready 的任务不会自动执行。

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
