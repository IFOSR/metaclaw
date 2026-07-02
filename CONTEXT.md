# MetaClaw Routing Context

The vocabulary for how MetaClaw decides which executor(s) run a user request. Exists because the old routing layer conflated several concepts (who runs, how verified, how risky) under one `ExecutionPlanV2`, which made quality-aware routing impossible.

## Current Implementation Notes

The active execution path is policy-first. Natural-language input is classified by `src/core/intent-orchestrator.ts` and `src/core/semantic-intent-router.ts` into interaction type plus one `CapabilityClass`. Session code reaches executor selection through `src/core/executor-routing-coordinator.ts`, `src/core/execution-planning-service.ts`, and `src/routing/execution-policy-planner.ts`. `ExecutionPolicyPlanner` owns the primary executor, candidate executors, fallback chain, risk level, verification level, acceptance criteria, and strategy handoff to `src/core/execution-strategy-planner.ts`.

`src/core/executor-router.ts` is a legacy compatibility seam. Keep its exported types, route-event shape, fallback intent helper, and capability/legacy-intent adapter functions stable for older callers, tests, and persisted route records. Do not add new primary routing behavior there unless the task explicitly targets compatibility. `historicalSuccess` remains profile/admin/storage metadata and must not be reintroduced into current scoring.

`src/core/llm-bridge.ts` still contains deprecated route-compatible schemas for old LLM flows; treat it as a process adapter and compatibility parser, not the owner of current routing policy. `src/core/semantic-intent-router.ts` may normalize legacy route intent names, but new behavior should prefer `CapabilityClass` values (`code_edit`, `research`, `messaging`, `memory_ops`, `office_automation`, `conversation`, `general`).

Default executor profiles are seeded in `src/executor/executor-registry-seeder.ts`. `codex-cli` is the normal default profile. Pi/Hermes are available when their commands are installed. `deepseek-tui`, `claude-code`, and `openclaw` are retained for explicit/default configuration compatibility, not default seeding.

When touching routing, update focused tests around the active path first: `tests/core/execution-planning-service.test.ts`, `tests/core/semantic-intent-router.test.ts`, `tests/core/intent-orchestrator.test.ts`, and only then `tests/core/executor-router.test.ts` for legacy compatibility behavior.

## Routing Language

**Task（任务）**:
A user-opened conversation window with a unique id and its own durable context, including user messages, task state, execution results, and later re-entry. A task may contain multiple subtasks, and tasks and subtasks use the same task state vocabulary.
_Avoid_: request, prompt, executor run, browser tab

**Subtask（子任务）**:
A decomposed piece of work inside a task, planned so it can be claimed and executed by one work unit at a time. Subtasks share the task state vocabulary rather than having a separate lifecycle language.
_Avoid_: work unit, executor instance, raw prompt

**Task State（任务状态）**:
The shared lifecycle vocabulary for tasks and subtasks, currently including states such as created, ready, running, parked, blocked, done, archived, and cancelled.
_Avoid_: executor state, work unit state

**Agent Class（Agent 类）**:
A fixed configuration template for a type of agent, including its harness, model, skills, MCP servers, plugins, and runtime settings. MetaClaw starts with two canonical classes: planner and executor.
_Avoid_: executor profile, capability class, instance, worker

**Planner（规划器）**:
The agent class responsible for task intake, subtask planning, dispatch decisions, human-instruction handling, and receiving reports from executor work units. A planner coordinates but does not perform executor work itself.
_Avoid_: leader, router agent, implementation agent, executor

**Executor（执行器）**:
The agent class responsible for carrying out claimed subtasks and reporting results back to the planner/task context. Executors do not own task planning.
_Avoid_: planner, leader, router

**Work Unit（工作单元）**:
A concrete runtime agent instance that belongs to an agent class and can be either a planner or an executor. A work unit is the runtime slot that starts, idles, claims work, runs, waits, heartbeats, drains, fails, or stops.
_Avoid_: subtask, task, agent class, capability class

**Work Unit State（工作单元状态）**:
The runtime lifecycle vocabulary for work units: starting, idle, claimed, running, waiting, heartbeat_lost, failed, draining, and stopped.
_Avoid_: task state, subtask state

**Work Graph（工作图）**:
The dependency graph of subtasks under one task. It describes what must be done, which subtasks depend on which prior subtasks, and what agent class or execution capability each subtask requires.
_Avoid_: raw prompt, route decision, executor plan, issue thread

**Work Unit Event（工作单元事件）**:
A durable runtime event about a work unit, such as state changes, claims, heartbeats, failures, draining, or stop events.
_Avoid_: TUI output line, transient progress text, task message

**Task Event（任务事件）**:
A durable event about a task or subtask, such as planned, ready, dispatched, blocked, succeeded, failed, cancelled, or resumed. Task events are the replayable source of truth for planner recovery; session output is only a UI projection.
_Avoid_: executor-only log, route event, progress line

**Task Runtime View（任务运行视图）**:
The runtime picture MetaClaw maintains for a task: the task conversation, subtasks, current work graph, claimed work units, progress, and reports.
_Avoid_: executor-only status, route event, transcript

**No Action**:
A valid planner outcome meaning no subtask should be dispatched. The runtime must preserve it as an intentional decision rather than forcing an executor run.
_Avoid_: failure, clarification, unknown route

**Selection Signal**:
A hard, quantifiable fact provided to the planner or routing skill package when multiple work units can satisfy a subtask, such as recent success rate, pending load, price, or current availability.
_Avoid_: affinity score, historical success as static truth, preference

**Fallback Chain**:
The ordered recovery path when a claimed work unit fails or produces low-quality output. Fallback starts after the current attempt definitively fails or misses its claim/heartbeat expectations.
_Avoid_: race, racing, parallel candidates, competing executors

**Verification Level**:
The strength of post-execution validation: none, compile, test, or review.
_Avoid_: quality gate, acceptance check, validator

**Worktree Isolation**:
The mechanism for running parallel executor work units without mutual file interference. Each parallel or isolated execution receives a dedicated git worktree.
_Avoid_: workspace lock, file locking, sandbox

**Worktree Lease**:
The runtime claim that one work unit currently owns a specific worktree for one subtask. A lease has an owner, heartbeat, expiry, and release path so crashed executions can be detected and the worktree can be made available again.
_Avoid_: permanent workspace ownership, executor identity, static work directory assignment
