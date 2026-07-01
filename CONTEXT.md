# MetaClaw Routing Context

The vocabulary for how MetaClaw decides which executor(s) run a user request. Exists because the old routing layer conflated several concepts (who runs, how verified, how risky) under one `ExecutionPlanV2`, which made quality-aware routing impossible.

## Current Implementation Notes

The active execution path is policy-first. Natural-language input is classified by `src/core/intent-orchestrator.ts` and `src/core/semantic-intent-router.ts` into interaction type plus one `CapabilityClass`. Session code reaches executor selection through `src/core/executor-routing-coordinator.ts`, `src/core/execution-planning-service.ts`, and `src/routing/execution-policy-planner.ts`. `ExecutionPolicyPlanner` owns the primary executor, candidate executors, fallback chain, risk level, verification level, acceptance criteria, and strategy handoff to `src/core/execution-strategy-planner.ts`.

`src/core/executor-router.ts` is a legacy compatibility seam. Keep its exported types, route-event shape, fallback intent helper, and capability/legacy-intent adapter functions stable for older callers, tests, and persisted route records. Do not add new primary routing behavior there unless the task explicitly targets compatibility. `historicalSuccess` remains profile/admin/storage metadata and must not be reintroduced into current scoring.

`src/core/llm-bridge.ts` still contains deprecated route-compatible schemas for old LLM flows; treat it as a process adapter and compatibility parser, not the owner of current routing policy. `src/core/semantic-intent-router.ts` may normalize legacy route intent names, but new behavior should prefer `CapabilityClass` values (`code_edit`, `research`, `messaging`, `memory_ops`, `office_automation`, `conversation`, `general`).

Default executor profiles are seeded in `src/executor/executor-registry-seeder.ts`. `codex-cli` is the normal default profile. Pi/Hermes are available when their commands are installed. `deepseek-tui`, `claude-code`, and `openclaw` are retained for explicit/default configuration compatibility, not default seeding.

When touching routing, update focused tests around the active path first: `tests/core/execution-planning-service.test.ts`, `tests/core/semantic-intent-router.test.ts`, `tests/core/intent-orchestrator.test.ts`, and only then `tests/core/executor-router.test.ts` for legacy compatibility behavior.

## Routing Language

**Task**:
A top-level durable user goal accepted by MetaClaw. A task may contain multiple work units, and those work units may run on different executors as long as their executor sessions are isolated and tracked under the same task.
_Avoid_: request, user input, executor run, single executor

**Single Active Task**:
The admission rule that MetaClaw accepts only one top-level task for execution at a time. It does not mean one work unit, one executor, or no internal parallelism; while the active task runs, new unrelated top-level tasks are rejected at the intake boundary. This is a **deliberate current-scope decision** (see [`docs/adr/0011-single-active-task-admission-gate.md`](docs/adr/0011-single-active-task-admission-gate.md)): to reduce development load while the routing layer is the priority, multi-task queueing / preemption / auto-resume of a *second* task are intentionally disabled and enforced by `TaskAdmissionGate` (`src/session/task-admission-gate.ts`). It is reversible — relax the gate (don't delete it) when multi-task scheduling is reprioritized.
_Avoid_: single executor, single work unit, no parallelism, no decomposition

**ExecutionPolicy**:
The output of the routing decision. Replaces `ExecutionPlanV2`. Describes not only *who runs* but *how the result is verified*, *whether isolation is required*, and *what happens on failure*.
_Avoid_: ExecutionPlan, ExecutionPlanV2, plan

**Work Unit**:
The execution granularity inside a task: a single, already-decomposed piece of work with a clear goal and required capability. The router consumes work units and decides dispatch for each; a work unit may also be called a subtask when emphasizing that it belongs to a parent task.
_Avoid_: top-level task, request, user input (too raw), executor run

**Leader**:
The temporary coordinator for one top-level task. A leader decomposes the task into a work graph, records work-unit events, and dispatches ready work units through MetaClaw's runtime. It does not perform implementation, research, writing, review, or other executor work itself.
_Avoid_: executor, worker, always-on router, implementation agent

**Work Graph**:
The dependency graph of work units under one top-level task. It describes what must be done, which work units depend on which prior work units, and what capability class each work unit needs. It is the leader's planning output and the runtime's scheduling input.
_Avoid_: raw prompt, route decision, executor plan, issue thread

**Work Unit Event**:
A durable event about a work unit or work graph, such as planned, ready, dispatched, blocked, succeeded, failed, cancelled, or lease-expired. Work unit events are the replayable source of truth for leader recovery; session output is only a UI projection.
_Avoid_: TUI output line, transient progress text, executor-only log

**Task Runtime View**:
The runtime picture MetaClaw maintains for the active task: the parent task, its work units, each work unit's executor session, work unit progress, and executor state. This is task state, not just executor telemetry.
_Avoid_: executor-only status, route event, transcript

**Primary Executor**:
The single executor that owns the main execution for a request. Every policy has exactly one.
_Avoid_: selected executor, main agent, dispatcher target

**Complementary Executor**:
A standby executor selected because it covers a *different capability class* than the primary — e.g. one coding agent (Codex CLI / Claude Code) plus one office/automation agent (OpenClaw / Hermes). Complementarity, not redundancy, is the selection principle. Availability and customer subscription constrain the choice.
_Avoid_: candidate executor, backup executor, secondary agent, standby (too vague)

**Parallelism Criterion**:
Whether executors run in parallel or in sequence is decided by *causal dependence*, not by executor type or count. Causally independent work units within the active task may run in parallel, each in an isolated worktree; causally dependent work units run in dependency order under the same parent task.
_Avoid_: concurrent execution (too vague), parallel agents, single-executor-only task

**Capability Class**:
A coarse classification of a request's needed competence, defined by *tool/side-effect boundary* (not executor strength). Seven values: `code_edit | research | messaging | memory_ops | office_automation | conversation | general`. A complementary set is built by picking one executor per relevant class. Supersedes the legacy `TaskRouteIntent`, which was the index key of the disused affinity-scoring model and carried wrong granularity (no office/automation class; treated model-level `reasoning` as a routing class).
_Avoid_: intent (overloaded with the legacy intent router), domain (overloaded with executor profile domains), TaskRouteIntent, reasoning-as-a-class

**Executor Instance**:
A runtime worker slot that can claim one work unit at a time for a specific capability class. A leader may request a capability class, but only the runtime claim step selects an executor instance and authorizes execution.
_Avoid_: leader-selected agent, permanent worker identity, capability class

**No Action**:
A valid leader planning outcome meaning no work unit should be dispatched. The runtime must preserve it as an intentional decision rather than forcing a fallback executor run.
_Avoid_: failure, clarification, unknown route

**Selection Signal**:
A hard, quantifiable fact the routing tool layer provides to the LLM when multiple executors satisfy a work unit's required capability. The LLM — not the tool layer — decides how to weigh them. Three signals are defined: recent success rate (last 3 tasks per candidate executor, from `executor_route_events.result`), pending load (queued/running task count per executor), and price. These are the *personal-user / open-source* selection strategy; enterprise routing (efficiency/robustness/quality-tuned) is out of scope and documented only as an advanced option.
_Avoid_: affinity score, historical success (the dead static value), preference

**Fallback Chain**:
The ordered executors tried sequentially when the primary fails or produces low-quality output. Replaces the `race_executors` mode. Only the *next* executor runs after the previous one has *definitively* failed — no parallel racing, no wasted tokens.
_Avoid_: race, racing, parallel candidates, competing executors

**Verification Level**:
The strength of post-execution validation: `none | compile | test | review`. When `review`, a `reviewerExecutor` (distinct from the primary) judges the result.
_Avoid_: quality gate, acceptance check, validator

**Worktree Isolation**:
The mechanism for running parallel executor sessions without mutual file interference. Each parallel work unit or isolated executor session gets a dedicated `git worktree` (an independent working directory on its own branch, sharing the `.git` object store). Within a single worktree, only one executor session runs at a time; the parent task coordinates the isolated work unit results.
_Avoid_: workspace lock, file locking (too weak because it detects but does not prevent), sandbox (different concept)

**Worktree Lease**:
The runtime claim that one executor session currently owns a specific worktree for one work unit. A lease has an owner, heartbeat, expiry, and release path so crashed executions can be detected and the worktree can be made available again.
_Avoid_: permanent workspace ownership, executor identity, static work directory assignment

**Estimated Cost Class**:
A prior, type-based cost band (`cheap | moderate | expensive`) used to decide whether spending tokens on a reviewer is justified. Derived from request type and estimated IO scale — *not* from historical statistics, so it cannot decay into a dead static value like the legacy `historicalSuccess`.
_Avoid_: token cost, budget, historical success
