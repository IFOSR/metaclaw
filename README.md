# MetaClaw

[English](README.md) | [中文](README.zh-CN.md)

MetaClaw is an agentic operations workbench for long-running knowledge work. It keeps tasks, memory, executor routing, Feishu delivery, and generated artifacts in one auditable local system.

It is built for teams who need AI agents to keep working across interruptions, recover context precisely, route work to the right executor, and deliver results back to the places where people actually review them.

## What MetaClaw Does

- Keeps durable tasks with explicit states: created, ready, running, parked, blocked, done, archived, and cancelled.
- Restores interrupted work with resume context instead of restarting from scratch.
- Auto-resumes executable parked tasks when the scheduler is idle.
- Uses semantic priority, not keyword matching, to decide urgent preemption and resume ordering.
- Routes work across multiple executors by task intent and ownership boundaries.
- Recalls preferences and task memory with review before executor injection.
- Captures generated files as task artifacts.
- Sends Feishu chat replies, file artifacts, and Markdown preview links through the backend delivery layer.
- Provides a local Gateway so multiple terminals can connect to one MetaClaw runtime.

## Current Executors

MetaClaw supports these executor adapters:

| Executor | Command | Best For | Install Requirement |
| --- | --- | --- | --- |
| Codex CLI | `codex` | Repository edits, tests, deterministic implementation, code review with patches | Install and authenticate the OpenAI Codex CLI |
| DeepSeek TUI | `deepseek-tui` | DeepSeek reasoning, Chinese technical analysis, algorithm/math reasoning, terminal-native DeepSeek workflows | Install and authenticate `deepseek-tui` |
| Hermes Agent | `hermes` | Research workflows, multi-tool automation, memory/gateway/assistant workflows | Install and authenticate `hermes` |
| Claude Code | `claude` | Compatible fallback executor for code and terminal-agent workflows | Optional; install and authenticate Claude Code |

The default executor is `codex`. The router can select `codex-cli`, `deepseek-tui`, or `hermes-agent` when those commands are installed and registered.

## Prerequisites

Required:

- Node.js `>=20.0.0`.
- npm.
- Git.
- A Unix-like shell environment. macOS and Linux are the primary targets.
- Native build tooling for `better-sqlite3`.

Recommended native build tools:

```bash
# macOS
xcode-select --install

# Ubuntu / Debian
sudo apt-get update
sudo apt-get install -y build-essential python3 make g++
```

Executor prerequisites:

- Install and log in to OpenAI Codex CLI if you want the default `codex-cli` executor.
- Install and log in to DeepSeek TUI if you want semantic technical reasoning routed to `deepseek-tui`.
- Install and log in to Hermes Agent if you want research, memory, gateway, and workflow automation routed to `hermes-agent`.
- Optionally install Claude Code if you want `claude-code` compatibility.

Feishu prerequisites, only if you use Feishu integration:

- A Feishu app with message receive/send permissions.
- An app secret stored in an environment variable such as `FEISHU_APP_SECRET`.
- Event subscription configured for `im.message.receive_v1` if using two-way Feishu chat.
- File upload/send-message permissions if you want generated artifacts sent back as Feishu file messages.
- A public reverse proxy or tunnel if Feishu must reach your local event endpoint or Markdown preview server.

Markdown preview prerequisites:

- `integrations.markdown_preview.enabled: true`.
- A reachable `public_base_url` if users open preview links outside the host machine.

## Install

Clone the repository:

```bash
git clone https://github.com/IFOSR/metaclaw.git
cd metaclaw
```

Install dependencies and build:

```bash
npm install
npm run build
```

Expose the local CLI:

```bash
npm link
```

Check the CLI:

```bash
metaclaw --help
```

## Install Executors

MetaClaw does not vendor the downstream executor CLIs. Install the ones you want to use and make sure each command is available on `PATH`.

### Codex CLI

Install and authenticate Codex CLI according to the official OpenAI Codex instructions. Then verify:

```bash
which codex
codex --help
```

Use Codex as the default executor:

```yaml
executor:
  command: codex
  timeout: 300
  max_duration: 3600
```

### DeepSeek TUI

Install and authenticate `deepseek-tui`, then verify:

```bash
which deepseek-tui
deepseek-tui --help
```

MetaClaw calls it as:

```bash
deepseek-tui exec --auto "<prompt>"
```

Use it as the default executor if desired:

```yaml
executor:
  command: deepseek-tui
```

### Hermes Agent

Install and authenticate Hermes, then verify:

```bash
which hermes
hermes --help
```

MetaClaw calls it as:

```bash
hermes --oneshot "<prompt>" --yolo --accept-hooks
```

`--oneshot` runs Hermes in script/headless mode, `--yolo` bypasses dangerous-command approval prompts, and `--accept-hooks` auto-accepts unseen hooks. This is required because MetaClaw executor runs cannot rely on an interactive terminal confirmation mid-task.

Use it as the default executor if desired:

```yaml
executor:
  command: hermes
```

### Claude Code

Claude Code is optional. Install and authenticate it if you want the compatibility adapter:

```bash
which claude
claude --help
```

Use it as the default executor if desired:

```yaml
executor:
  command: claude
```

## Run

Start the TUI:

```bash
metaclaw
```

Or use the project helper:

```bash
./metaclaw.sh start
```

On first launch, MetaClaw creates its local state under:

```text
~/.metaclaw/
├── config.yaml
├── metaclaw.db
└── gateway.sock
```

Connect a second terminal to the same runtime:

```bash
./metaclaw.sh connect
```

Runtime utilities:

```bash
./metaclaw.sh status
./metaclaw.sh logs
./metaclaw.sh logs -f
./metaclaw.sh restart
./metaclaw.sh stop
```

Direct Gateway modes:

```bash
metaclaw --gateway
metaclaw --connect
```

## Configuration

Edit:

```bash
~/.metaclaw/config.yaml
```

Example:

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
  language: en-US
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

Export the Feishu app secret before starting the runtime:

```bash
export FEISHU_APP_SECRET="your Feishu app secret"
./metaclaw.sh start
```

## Feishu Delivery And Markdown Preview

MetaClaw separates document generation from Feishu delivery:

- The executor writes Markdown or other files into the task output directory.
- MetaClaw records those files as task artifacts.
- The Feishu backend sends the final answer back to chat.
- The Feishu backend uploads generated artifact files when file upload is available.
- Markdown artifacts get online preview links when Markdown Preview is configured.

Executors should not call Feishu Docs or cloud-document APIs directly. If a user asks for a "Feishu cloud document" or "online preview", MetaClaw instructs the executor to produce local Markdown artifacts; the backend handles Feishu synchronization and preview links.

Feishu progress cards show the execution chain explicitly. MetaClaw first sends the request to `codex-cli` for intent parsing and execution preparation, then shows the router decision, routing reason, and the actual executor that starts the task, for example `hermes-agent` for research workflows. This prevents Feishu users from mistaking the intent parser for the final executor.

Default preview URL:

```text
http://127.0.0.1:8790/preview/<artifact>
```

For Feishu users outside the host machine, expose the preview service and set:

```yaml
integrations:
  markdown_preview:
    enabled: true
    host: 127.0.0.1
    port: 8790
    public_base_url: https://preview.example.com
```

## Task Workflow

Create a task in natural language:

```text
> Compare these three contracts and create a risk matrix.
```

MetaClaw will:

1. Classify the input as conversation, task control, or durable work.
2. Create or resolve the target task.
3. Apply semantic task priority.
4. Ask for recall review if relevant memory is available.
5. Route the task to the best executor.
6. Execute and stream progress.
7. Store result summaries, artifacts, and task memory.
8. Suggest what to do next.

Useful commands:

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

## Scheduler And Priority Model

MetaClaw uses a single active executor with a scheduler in front of it.

- New tasks are scored by urgency, readiness, continuity benefit, downstream impact, and staleness.
- Urgency is based on structured semantic priority, not keyword matching.
- Executable parked tasks auto-resume when the system is idle.
- Semantically urgent parked tasks resume before normal parked tasks.
- Blocked or not-ready tasks do not auto-run.

This prevents queued work from wasting compute while preserving task safety.

## Executor Routing

Routing is intent-first:

- `repo_execution` goes to `codex-cli` by default.
- `technical_reasoning` goes to `deepseek-tui` when DeepSeek, algorithm, math, or Chinese technical reasoning is explicit.
- `research_workflow` goes to `hermes-agent`.
- `memory_agent_ops` goes to `hermes-agent`.
- Explicit executor names are respected when available.

The router records selected executor, confidence, primary intent, matched boundary, rejected candidates, and routing reason.

## Memory And Recall Review

MetaClaw stores confirmed preferences, observations, task memory cards, recall events, and learning candidates in SQLite.

Memory is not silently injected into executor prompts. Relevant memories appear in review cards, and the user can accept, reject, or select specific items.

Commands:

```bash
/memory
/memory candidates
/memory confirm obs_123 --scope contact --subject Alex
/memory add Alex prefers formal updates with legal copied
/memory search formal
/memory edit <pref_id> --scope project Use tables for outputs
/memory delete <pref_id>
/memory stats
/memory review-policy
```

## Learning Loop

MetaClaw can turn successful tasks, failures, artifacts, and executor skill usage into learning candidates.

Commands:

```bash
/learning candidates
/learning approve <candidate_id> [note]
/learning reject <candidate_id> [reason]
/learning promote <candidate_id>
/learning cards
/learning skills
/learning summary
/learning weekly
```

## Scripted Smoke Test

```bash
cat > /tmp/metaclaw-flow.txt <<'EOF'
Compare the risk points across three contracts and produce a concise table.
/tasks done
EOF

metaclaw --script /tmp/metaclaw-flow.txt
```

`--script` executes input line by line. Blank lines and lines starting with `#` are ignored.

## Development

```bash
npm run dev
npm run build
npm test
npm run lint
```

Targeted tests:

```bash
npm test -- tests/core/executor-router.test.ts
npm test -- tests/core/scheduler.test.ts
npm test -- tests/integrations/feishu-app.test.ts
npm test -- tests/session/scripted-session.test.ts
```

## Repository Layout

```text
src/
├── cli/            # CLI args: --script, --gateway, --connect
├── commands/       # Slash command router and handlers
├── core/           # Task, memory, recall, scheduler, routing engines
├── executor/       # Executor adapters, prompt builders, skill packages
├── gateway/        # Local Gateway server/client
├── integrations/   # Feishu app integration and Markdown preview
├── notifications/  # Feishu notifications
├── session/        # Interactive and scripted session runtime
├── storage/        # SQLite migrations and repositories
├── tui/            # Ink terminal UI
└── utils/          # Config, paths, logger, IDs
```

## License

MIT
