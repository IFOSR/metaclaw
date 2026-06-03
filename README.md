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
- Recalls only clearly applicable preferences and task memory; uncertain recall is skipped by default so Feishu and unattended executors never wait for confirmation.
- Captures generated files as task artifacts.
- Sends Feishu chat replies, file artifacts, and Markdown preview links through the backend delivery layer.
- Provides a local Gateway so multiple terminals can connect to one MetaClaw runtime.

## Current Executors

MetaClaw supports these executor adapters:

| Executor | Command | Best For | Install Requirement |
| --- | --- | --- | --- |
| Codex CLI | `codex` | Repository edits, tests, deterministic implementation, code review with patches | Install and authenticate the OpenAI Codex CLI |
| Pi Agent | `pi` | Research tasks, report generation, multi-step synthesis, agentic CLI workflows | Install `@earendil-works/pi-coding-agent` and authenticate Pi |
| Hermes Agent | `hermes` | Research tasks, multi-tool orchestration, memory/gateway/assistant workflows | Install and authenticate Hermes |

The default executor is `codex`. The default router can select `codex-cli` for repository work. For research work, MetaClaw can dispatch Pi Agent and Hermes Agent in parallel and keep whichever returns first, aborting the slower executor. DeepSeek TUI remains available as a legacy/manual adapter, but it is retired from the default executor registry and automatic route candidates.

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
- Install and log in to Pi Agent and Hermes Agent if you want research routed through the parallel research race.

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

Recommended one-command setup:

```bash
git clone https://github.com/IFOSR/metaclaw.git
cd metaclaw
./setup.sh
```

`setup.sh` installs MetaClaw itself, builds the local CLI, links `metaclaw`, creates `~/.metaclaw/config.yaml`, and detects installed executors on `PATH`.

In an interactive terminal it shows the detected executor list, lets you choose which executors to connect, and asks which one should be the default. If a selected auto-installable executor is missing, setup can install it for you. Codex CLI is the default fallback when no executor is available:

```bash
npm install -g @openai/codex
```

Setup options:

```bash
# Do not overwrite an existing ~/.metaclaw/config.yaml
METACLAW_OVERWRITE_CONFIG=false ./setup.sh

# Rewrite ~/.metaclaw/config.yaml
METACLAW_OVERWRITE_CONFIG=true ./setup.sh

# Build MetaClaw but skip npm link
METACLAW_INSTALL_MODE=none ./setup.sh

# Do not auto-install Codex CLI when no executor is found
METACLAW_INSTALL_CODEX=false ./setup.sh

# Force non-interactive defaults
METACLAW_SETUP_INTERACTIVE=false ./setup.sh
```

Manual fallback:

```bash
npm install
npm run build
npm link
```

Check the CLI:

```bash
metaclaw --help
```

## Install Executors

MetaClaw does not vendor the downstream executor CLIs. Install the ones you want to use and make sure each command is available on `PATH`.

### Register Custom Executors

Installed executors are runtime workers that MetaClaw can route tasks to. A registered executor now has two parts:

- The routing profile: domains, capabilities, risk level, success history, input/output types, and use-case hints.
- The runtime binding: local command, non-interactive arguments, install check command, and optional project URL.

Use the guided registration flow when you are not sure what to fill in:

```bash
/executor register wizard
```

The wizard asks for the executor name, whether to infer from a project URL or fill fields manually, the local command, non-interactive args, install check command, domains, and capabilities. If you provide a GitHub URL, MetaClaw tries to infer CLI information from `package.json` or README examples. If inference is not reliable, it falls back to manual entry.

One-line registration is also supported:

```bash
/executor register research-bot \
  --command research-bot \
  --args "run --prompt {prompt}" \
  --check "research-bot --version" \
  --project-url https://github.com/example/research-bot \
  --domains research,reporting \
  --capabilities research,report_generation
```

`{prompt}` is replaced with the task prompt. If `--args` does not contain `{prompt}`, MetaClaw appends the prompt as the final argument. Before dispatching to a custom executor, MetaClaw runs the configured check command. If the check fails, the executor is marked `unavailable` and the task falls back to the default executor.

Executor management commands:

```bash
/executor list
/executor register wizard
/executor unregister <name>
/executor route <task description>
/executor route-feedback
```

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

`timeout` is a continuous no-output watchdog, not a fixed wall-clock runtime limit. MetaClaw resets it whenever the executor writes stdout or stderr, so a live executor can keep running as long as it continues to show activity. `max_duration` is kept for backward-compatible configuration files and is not used to kill active executor processes.

### Pi Agent

Install the Pi coding agent CLI and authenticate it:

```bash
npm install -g @earendil-works/pi-coding-agent
which pi
pi --help
```

MetaClaw calls it as:

```bash
pi -p "<prompt>"
```

Pi research workflows often run longer than CLI coding tasks. MetaClaw automatically gives `pi-agent` at least `timeout: 900` seconds of continuous no-output idle time, even if the global executor config is shorter. Active Pi processes are not stopped by a hard total-duration limit.

Use Pi as the default executor if desired:

```yaml
executor:
  command: pi
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

`--oneshot` runs Hermes in script/headless mode, `--yolo` bypasses dangerous-command approval prompts, and `--accept-hooks` auto-accepts unseen hooks. Research workflows can run Pi Agent and Hermes Agent concurrently; MetaClaw records the first returned result and aborts the other executor.

### Retired Legacy Adapters

The `deepseek-tui`, `claude-code`, and `openclaw` adapters are retained for compatibility and explicit local configuration, but they are not seeded into the default executor registry unless explicitly configured as the default executor.

```bash
executor:
  command: hermes        # legacy/manual
  # command: deepseek-tui # legacy/manual
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

Feishu progress cards show the execution chain explicitly. MetaClaw first sends the request to `codex-cli` for intent parsing and execution preparation, then shows the router decision, routing reason, and the actual executor that starts the task. Research workflows can show a `pi-agent + hermes-agent` race, where the first returned result is kept and the slower executor is aborted. This prevents Feishu users from mistaking the intent parser for the final executor.

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
- `research_workflow` can race `pi-agent` and `hermes-agent`; the first returned result wins and the slower executor is aborted.
- `memory_agent_ops` goes to `pi-agent` when available, otherwise falls back to the default executor.
- Explicit executor names are respected when available.

The router records selected executor, confidence, primary intent, matched boundary, rejected candidates, and routing reason.

## Executors Vs Skills

Executors and Skills are different layers of the ecosystem.

An Executor is who does the work. A Skill is the method, knowledge, or operating guide the worker uses while doing it.

Executors are agent runtimes such as Codex CLI, Pi Agent, Hermes Agent, DeepSeek TUI, or a domain-specific local agent. An executor determines the model, toolchain, permissions, runtime environment, context window, file access, non-interactive command, cost profile, and reliability boundary.

Skills are lighter capability packages. They describe how to perform a specific class of work: how to analyze futures contracts, how to review code, how to run a research workflow, or what output format to use. A Skill can improve an executor's behavior, but it does not automatically change the executor's runtime, permissions, tools, or installation state.

Executor strengths:

- Adds a new runtime boundary: model, tools, credentials, permissions, and command-line behavior.
- Lets MetaClaw route work to the executor that is best suited for that task.
- Enables fallback, racing, cross-checking, and audit trails across different agents.
- Can integrate private or domain-specific systems that a generic Skill cannot access.

Executor tradeoffs:

- Heavier to install and configure.
- Requires a non-interactive command and an availability check.
- Needs permission, timeout, failure, and fallback handling.
- Can create operational complexity if many runtimes behave differently.

Skill strengths:

- Lightweight and fast to add.
- Good for encoding repeatable methods, checklists, domain heuristics, and output conventions.
- Can improve consistency within a single executor.
- Lower operational overhead than adding a new runtime.

Skill tradeoffs:

- Bound by the host executor's tools, permissions, context, and model.
- Cannot make an unavailable CLI, private API, browser, file permission, or enterprise integration appear by itself.
- Usually improves execution quality rather than expanding the runtime boundary.

MetaClaw uses executor registration when the missing capability is a different worker or runtime. It uses Skills when the worker exists but needs better procedure, domain knowledge, or formatting discipline.

## Memory And Recall Review

MetaClaw stores confirmed preferences, observations, task memory cards, recall events, and learning candidates in SQLite.

Memory is never injected blindly. Clearly applicable memories are applied automatically with an audit trail; uncertain memories are skipped by default instead of asking for confirmation. Feishu and unattended executor flows therefore keep moving without interactive prompts.

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
