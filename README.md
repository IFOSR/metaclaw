# MetaClaw

[English](README.md) | [中文](README.zh-CN.md)

MetaClaw is a local AI Task OS for agentic work. It turns natural-language requests into durable, searchable, schedulable, and verifiable tasks that can survive interruptions, recall prior context, route work to the right executor, and deliver artifacts back to the places where people review them.

It is built for teams who need agents to do more than answer the current turn. MetaClaw gives long-running AI work a task state machine, memory boundary, executor routing layer, verification loop, local Gateway, Feishu delivery path, and real end-to-end smoke gate.

## What MetaClaw Does

- Keeps durable tasks with explicit states: created, ready, running, parked, blocked, done, archived, and cancelled.
- Restores interrupted work with resume context instead of restarting from scratch.
- Auto-resumes executable parked tasks when the scheduler is idle.
- Uses semantic priority, not keyword matching, to decide urgent preemption and resume ordering.
- Searches historical tasks with a local SQLite FTS index and hybrid retrieval.
- Plans complex work as explicit work units with acceptance criteria and aggregation rules.
- Routes work across executors by task intent, executor capability, and ownership boundaries.
- Provides a tested Agentic Loop core that aggregates executor results, checks evidence, and feeds failures back for retry.
- Recalls only clearly applicable preferences and task memory; uncertain recall is skipped by default so Feishu and unattended executors never wait for confirmation.
- Captures generated files as task artifacts.
- Sends Feishu chat replies, file artifacts, and Markdown preview links through the backend delivery layer.
- Provides a local Gateway so multiple terminals can connect to one MetaClaw runtime.
- Shows the interactive TUI input, current task, routing status, execution preparation, executor progress, and final task result so users can follow the core execution path instead of seeing only the final answer.
- Supports terminal-native editing in the TUI composer, including spaces, multiline input, left/right cursor movement, Backspace at the cursor, and forward delete when the terminal emits a raw delete sequence.
- Ships with `npm run smoke:metaclaw`, a real MetaClaw end-to-end smoke gate that runs the CLI, executor, artifact capture, and regression checks.

## Core Architecture

MetaClaw is task-oriented rather than session-only. A normal agent session answers the current turn. MetaClaw decides whether an input should stay as a lightweight conversation, control an existing task, or become durable work that can be scheduled, blocked, resumed, searched, verified, and audited.

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
    ├── TaskEngine: task state machine
    ├── SchedulerEngine: queue, priority, preemption, resume
    ├── OrchestrationEngine: dashboard, guidance, blocked/parked review
    ├── MemoryEngine: preferences, task memory, recall review
    └── MetaclawSession: interactive/script/gateway runtime coordinator
          │
          ▼
Task Retrieval Layer
    ├── TaskSearchIndexRepo: SQLite FTS task index
    └── HybridTaskRetriever: explicit, focus, FTS, relation, recent, feedback, semantic rerank
          │
          ▼
Execution Strategy Layer
    ├── ExecutorRouter: intent-aware executor selection
    ├── ExecutionStrategyPlanner: single executor or multi-executor work units
    └── Acceptance criteria: user request, tests, sources, artifacts, review verdicts
          │
          ▼
Agentic Verification Layer
    ├── MultiExecutorOrchestrator: sequential/parallel work-unit fan-out
    ├── ExecutionAggregator: merge, verify, flag conflicts, collect artifacts
    └── AgenticLoopController: retry failed units until pass or blocked
          │
          ▼
Executor And Delivery Layer
    ├── Executor adapters: Codex, Pi, Hermes, custom CLI
    └── Backend delivery: Feishu, artifacts, Markdown preview
```

The conversation/task boundary matters:

- Conversation: answer now, do not create durable state. Good for explanations, clarification, and status questions.
- Task control: inspect or change existing task state. Good for "what is running?", "resume that task", or "clear blocked tasks".
- Durable task: create or continue work that needs execution, persistence, artifacts, recovery, scheduling, or later retrieval.

The Task OS upgrade described in [MetaClaw Task OS Architecture And Strategy Upgrade](docs/plans/2026-06-14-metaclaw-task-os-architecture-strategy-upgrade.md) is now reflected in the codebase: task search indexing, hybrid task retrieval, execution strategy planning, multi-executor work units, aggregation, verification, and the Agentic Loop core are implemented and covered by targeted tests. Broad Executor Discovery, remote registries, and large multi-client Gateway expansion remain intentionally out of scope for this cycle.

Important runtime boundary: the Agentic Loop is implemented as a core architecture layer and tested directly. The current interactive/script session path still uses the existing session runtime unless a feature path explicitly calls the strategy/orchestration loop.

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
- A Unix-like shell environment. macOS and Linux are primary targets; Windows users should use WSL2 for the supported install path.
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

Feishu prerequisites, only if you use Feishu Gateway integration:

- A Feishu app with message receive/send permissions.
- An app secret stored in an environment variable such as `FEISHU_APP_SECRET`.
- Event subscription configured for `im.message.receive_v1`.
- File upload/send-message permissions if you want generated artifacts sent back as Feishu file messages.
- WebSocket event delivery is recommended because it does not require a public callback URL.
- A public reverse proxy or tunnel is only required for webhook mode or external Markdown preview links.

Markdown preview prerequisites:

- `integrations.markdown_preview.enabled: true`.
- A reachable `public_base_url` if users open preview links outside the host machine.

## Install

For most users, install and verify in this order:

```bash
git clone https://github.com/IFOSR/metaclaw.git
cd metaclaw
./setup.sh
metaclaw --help
npm run smoke:metaclaw
```

The install is usable when `metaclaw --help` prints the CLI help and `npm run smoke:metaclaw` ends with:

```text
MetaClaw real task smoke passed.
Artifact: /tmp/.../smoke-result.md
```

`setup.sh` installs MetaClaw itself, builds the local CLI, links `metaclaw`, creates `~/.metaclaw/config.yaml`, and detects installed executors on `PATH`.

In an interactive terminal it shows the detected executor list, lets you choose which executors to connect, and asks which one should be the default. If a selected auto-installable executor is missing, setup can install it for you. Codex CLI is the default fallback when no executor is available:

```bash
npm install -g @openai/codex
```

If Codex CLI was installed during setup, open it once and finish login before running real tasks:

```bash
codex
```

Install checklist:

- `node --version` is `>=20`.
- `./setup.sh` finishes with "安装完成".
- `~/.metaclaw/config.yaml` exists.
- `metaclaw --help` works from a new shell.
- The default executor command works, for example `codex --help`.
- `npm run smoke:metaclaw` passes and prints the generated artifact path.

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

If `metaclaw` is not found after setup, first open a new shell so your `PATH` picks up the npm global link. If it is still missing, run the manual fallback again and check `npm config get prefix` to confirm that npm's global bin directory is on `PATH`.

## Windows Install

The recommended Windows path is WSL2 with Ubuntu. This gives MetaClaw the Unix-like shell, native build tooling, sockets, process behavior, and executor compatibility that the runtime expects.

Install WSL2 from PowerShell:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if prompted, then open Ubuntu and install prerequisites inside WSL:

```bash
sudo apt-get update
sudo apt-get install -y git curl build-essential python3 make g++

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

node --version
npm --version
git --version
```

Install and verify MetaClaw inside the WSL Ubuntu shell:

```bash
git clone https://github.com/IFOSR/metaclaw.git
cd metaclaw
./setup.sh
metaclaw --help
npm run smoke:metaclaw
```

If setup installs Codex CLI, open it once inside WSL and finish login before running real tasks:

```bash
codex
```

Windows install checklist:

- Run MetaClaw commands inside WSL Ubuntu, not Windows PowerShell.
- Keep the repository under the WSL filesystem, for example `~/metaclaw`, not `/mnt/c/...`, for better file and SQLite performance.
- Confirm `node --version` is `>=20`.
- Confirm `metaclaw --help` works in a fresh WSL shell.
- Confirm the default executor works in WSL, for example `codex --help`.
- Confirm `npm run smoke:metaclaw` prints `MetaClaw real task smoke passed.`

Native Windows PowerShell is not the primary supported runtime today. Advanced users can try the manual fallback with Node.js 20, Git, Visual Studio Build Tools, `npm install`, `npm run build`, and `node dist/index.js`, but `setup.sh`, `metaclaw.sh`, Unix socket Gateway behavior, and downstream executor CLIs may not behave the same way. Use WSL2 when you need a reliable installation.

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

Executor extension contract:

Required routing fields:

- `name`: stable executor name, such as `research-bot` or `finance-research-agent`.
- `domains`: where the executor fits, such as `research`, `finance`, or `software`.
- `capabilities`: what the executor can do, such as `research`, `report_generation`, `multi_tool`, `coding`, or `tests`.
- `availability`: `available` or `unavailable`; MetaClaw updates this when install checks fail.

Recommended routing fields:

- `inputTypes`: supported input types, such as `text`, `files`, or `image`.
- `outputTypes`: expected outputs, such as `markdown`, `report`, `code`, `patch`, or `json`.
- `primaryUseCases`: examples of tasks that should route to this executor.
- `avoidUseCases`: examples of tasks that should not route to this executor.
- `riskLevel`: `low`, `medium`, or `high`.
- `historicalSuccess`: success score used by routing as more task outcomes are recorded.
- `projectUrl`: source repository or documentation URL.

Required runtime binding:

- `runtimeCommand`: executable command available on `PATH`, for example `research-bot`.
- `runtimeArgs`: non-interactive arguments, for example `["run", "--prompt", "{prompt}"]`.
- `runtimeCheckCommand`: install or availability check, for example `research-bot --version`.

Runtime behavior requirements:

- The executor must run non-interactively; it cannot wait for human prompts.
- It must accept the full task prompt through `{prompt}` or as the final argument.
- It should write the final answer to stdout.
- Failures should return a non-zero exit code or a clear stderr error.
- Long-running tasks should emit progress periodically so the idle watchdog does not treat the process as stuck.
- File artifacts should be written into the task output directory provided in the prompt.
- Feishu delivery, file upload, and preview link generation should stay in MetaClaw's backend; executors should produce local artifacts instead of calling Feishu APIs directly.

Optional advanced adapter interfaces:

- `execute(input)`: run a task with structured context.
- `isAvailable()`: check whether the executor can run.
- `abort()`: cancel a running task.
- `installSkill(pkg)`, `updateSkill(pkg)`, `disableSkill(target)`, `deprecateSkill(target)`: support executor-specific Skill lifecycle management.

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

The interactive TUI is designed to keep the user oriented while work is running:

- Submitted user input is echoed into the transcript.
- The composer shows `processing`, `running <executor>`, `blocked`, or `idle`.
- The status panel shows the current task id, status, and title when a task is active.
- Core progress lines are shown during routing and execution, including request understanding, execution strategy, context recall, context construction, executor routing, executor progress, verification, and final result.
- The input composer supports normal terminal editing: spaces, multiline input with modified Enter/Ctrl+J, left/right cursor movement, Backspace deleting the character before the cursor, and forward delete for raw delete escape sequences.

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

Install or manage MetaClaw as a user-level service:

```bash
./metaclaw.sh gateway install
./metaclaw.sh gateway start
./metaclaw.sh gateway status
./metaclaw.sh gateway restart
./metaclaw.sh gateway stop
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
  blocked_recheck_enabled: true
  blocked_recheck_interval: 60

ui:
  language: en-US
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

Export the Feishu app secret before starting the runtime:

```bash
export FEISHU_APP_SECRET="your Feishu app secret"
./metaclaw.sh start
```

## Feishu Gateway Delivery And Markdown Preview

MetaClaw separates document generation from Feishu delivery:

- The executor writes Markdown or other files into the task output directory.
- MetaClaw records those files as task artifacts.
- The Feishu Gateway sends the final answer back to the origin chat.
- The Feishu Gateway uploads generated artifact files when file upload is available.
- Markdown artifacts get online preview links when Markdown Preview is configured.
- Delivery attempts are written to `~/.metaclaw/gateway-audit.jsonl`.

Executors should not call Feishu Docs or cloud-document APIs directly. If a user asks for a "Feishu cloud document" or "online preview", MetaClaw instructs the executor to produce local Markdown artifacts; the Gateway handles Feishu synchronization and preview links.

Feishu progress cards show the execution chain explicitly. MetaClaw first sends the request to `codex-cli` for intent parsing and execution preparation, then shows the router decision, routing reason, and the actual executor that starts the task. Research workflows can show a `pi-agent + hermes-agent` race, where the first returned result is kept and the slower executor is aborted. This prevents Feishu users from mistaking the intent parser for the final executor.

Final Feishu replies use Markdown message cards first. Long answers are split into multiple cards. If a card chunk fails, MetaClaw retries that chunk as a rich-text post; if any chunk still cannot be delivered, MetaClaw uploads the complete final answer as a Markdown file so the user does not receive a partial result.

Access control is handled by the Gateway:

- Direct messages default to `dm_policy: pairing`. The first DM user is approved automatically; later users can be approved or revoked with `metaclaw gateway pairing`.
- Group chats default to `group_policy: open` with `require_mention: true`.
- `/sethome` sent in a Feishu chat records that chat as `gateway.platforms.feishu.home_channel`.
- Legacy `integrations.feishu` settings are still read as a compatibility source, but new deployments should use `gateway.platforms.feishu`.

Useful Feishu Gateway commands:

```bash
metaclaw gateway doctor
metaclaw gateway pairing list
metaclaw gateway pairing approve <open_id>
metaclaw gateway pairing revoke <open_id>
```

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
3. Retrieve relevant historical task context when available.
4. Apply semantic task priority.
5. Route the task to the best executor.
6. For complex work, build work units and acceptance criteria.
7. Execute and stream progress.
8. Store result summaries, artifacts, and task memory.
9. Suggest what to do next.

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
/task index rebuild
/task index search <query>

/dashboard
/attach [taskId] <file paths...>
/history
/config
/help
/exit
```

## Task Search And Hybrid Retrieval

MetaClaw keeps a local SQLite FTS5 search index for tasks and task-related text. This makes historical work recoverable even when the user does not remember the exact task id.

Commands:

```bash
/task index rebuild
/task index search contract risk matrix
```

The hybrid retriever combines several signals:

- Explicit task references from the current request.
- Focused task context from the current session.
- Full-text matches from the task search index.
- Related tasks through task relations.
- Recent task activity.
- Feedback and prior execution traces.
- Semantic reranking across the candidate set.

Implicit recall excludes the current task, so a task does not accidentally recall itself during first execution. Uncertain memory is not injected blindly; unattended Gateway and Feishu flows keep moving instead of blocking on confirmation prompts.

## Scheduler And Priority Model

MetaClaw uses a single active executor with a scheduler in front of it.

- New tasks are scored by urgency, readiness, continuity benefit, downstream impact, and staleness.
- Urgency is based on structured semantic priority, not keyword matching.
- Executable parked tasks auto-resume when the system is idle.
- Semantically urgent parked tasks resume before normal parked tasks.
- The task pool watchdog periodically surfaces blocked and parked tasks with the missing condition or next step.
- Recoverable executor failures can be rechecked on a timer and moved back into scheduling when the executor is available again.
- Material, permission, authorization, and access blocks stay blocked until the user provides the missing input or explicitly unblocks the task.
- Not-ready tasks do not auto-run.

This prevents queued work from wasting compute while preserving task safety.

## Executor Routing

Routing is intent-first:

- `repo_execution` goes to `codex-cli` by default.
- `research_workflow` can race `pi-agent` and `hermes-agent`; the first returned result wins and the slower executor is aborted.
- `memory_agent_ops` goes to `pi-agent` when available, otherwise falls back to the default executor.
- Explicit executor names are respected when available.

The router records selected executor, confidence, primary intent, matched boundary, rejected candidates, and routing reason.

## Complex Task Strategy And Agentic Loop

MetaClaw can represent complex requests as a strategy instead of a single undifferentiated prompt. The strategy planner decides between:

- `single_executor`: one executor is enough.
- `multi_executor`: split the request into work units with executor hints, dependencies, inputs, expected output type, risk level, and acceptance checks.

The planner uses complexity signals such as explicit multi-agent wording, multiple capability domains, staged dependencies, high-risk validation, multiple resources, and relevant historical tasks.

For multi-executor strategies, the Agentic Loop core is:

1. Run work units through `MultiExecutorOrchestrator`.
2. Aggregate results with `ExecutionAggregator`.
3. Check required evidence: user request coverage, patch test evidence, research sources, artifact paths, review verdicts, missing work units, and cross-unit conflicts.
4. If verification passes, produce the final aggregated result.
5. If verification has concerns, append targeted feedback to failed work units and retry until the strategy passes or reaches `maxIterations`.
6. If it still fails, return `blocked` with the reason instead of silently shipping an unverified result.

This is the acceptance layer for agentic work: executor output is not treated as final just because a worker returned text. The core modules are implemented and tested; integration into each user-facing execution path is intentionally staged so existing runtime behavior remains stable.

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
npm run smoke:metaclaw
```

`npm run smoke:metaclaw` is the required real end-to-end smoke gate for feature work. It builds MetaClaw, starts `node dist/index.js --script` with an isolated temporary `METACLAW_HOME` and workspace, submits a real task, lets the configured executor create an artifact, and verifies the artifact path and file content. New runtime features should pass this smoke path, or the failure/skip reason must be called out explicitly.

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
