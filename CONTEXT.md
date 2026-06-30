# MetaClaw Routing Context

The vocabulary for how MetaClaw decides which executor(s) run a user request. Exists because the old routing layer conflated several concepts (who runs, how verified, how risky) under one `ExecutionPlanV2`, which made quality-aware routing impossible.

## Current Implementation Notes

The active execution path is policy-first. Natural-language input is classified by `src/core/intent-orchestrator.ts` and `src/core/semantic-intent-router.ts` into interaction type plus one `CapabilityClass`. Session code reaches executor selection through `src/core/executor-routing-coordinator.ts`, `src/core/execution-planning-service.ts`, and `src/routing/execution-policy-planner.ts`. `ExecutionPolicyPlanner` owns the primary executor, candidate executors, fallback chain, risk level, verification level, acceptance criteria, and strategy handoff to `src/core/execution-strategy-planner.ts`.

`src/core/executor-router.ts` is a legacy compatibility seam. Keep its exported types, route-event shape, fallback intent helper, and capability/legacy-intent adapter functions stable for older callers, tests, and persisted route records. Do not add new primary routing behavior there unless the task explicitly targets compatibility. `historicalSuccess` remains profile/admin/storage metadata and must not be reintroduced into current scoring.

`src/core/llm-bridge.ts` still contains deprecated route-compatible schemas for old LLM flows; treat it as a process adapter and compatibility parser, not the owner of current routing policy. `src/core/semantic-intent-router.ts` may normalize legacy route intent names, but new behavior should prefer `CapabilityClass` values (`code_edit`, `research`, `messaging`, `memory_ops`, `office_automation`, `conversation`, `general`).

Default executor profiles are seeded in `src/executor/executor-registry-seeder.ts`. `codex-cli` is the normal default profile. Pi/Hermes are available when their commands are installed. `deepseek-tui`, `claude-code`, and `openclaw` are retained for explicit/default configuration compatibility, not default seeding.

When touching routing, update focused tests around the active path first: `tests/core/execution-planning-service.test.ts`, `tests/core/semantic-intent-router.test.ts`, `tests/core/intent-orchestrator.test.ts`, and only then `tests/core/executor-router.test.ts` for legacy compatibility behavior.

## Routing Language

**ExecutionPolicy**:
The output of the routing decision. Replaces `ExecutionPlanV2`. Describes not only *who runs* but *how the result is verified*, *whether isolation is required*, and *what happens on failure*.
_Avoid_: ExecutionPlan, ExecutionPlanV2, plan

**Work Unit**:
The input granularity the router consumes — a single, already-decomposed piece of work with a clear goal and required capability. The router does not decompose; it receives work units (in the future, from a dedicated decomposition skill) and decides dispatch for each. Today's flat `Task` serves as a stand-in work unit since no decomposition step exists yet.
_Avoid_: subtask (implies a parent exists; none does today), request, user input (too raw)

**Primary Executor**:
The single executor that owns the main execution for a request. Every policy has exactly one.
_Avoid_: selected executor, main agent, dispatcher target

**Complementary Executor**:
A standby executor selected because it covers a *different capability class* than the primary — e.g. one coding agent (Codex CLI / Claude Code) plus one office/automation agent (OpenClaw / Hermes). Complementarity, not redundancy, is the selection principle. Availability and customer subscription constrain the choice.
_Avoid_: candidate executor, backup executor, secondary agent, standby (too vague)

**Parallelism Criterion**:
Whether executors run in parallel or in sequence is decided by *causal dependence*, not by executor type or count. Causally independent work (no output of one feeds another) runs in parallel, each in its own worktree — the isolation pattern, and the only meaning of `multi_executor`. Causally dependent work runs in sequence *across work units* (e.g. Claude Code finishes the code, then Hermes reports on it) — expressed as a chain of separate single-executor policies, never as one multi-executor policy. The decomposition-DAG (deferred) governs these dependent chains; the router treats each link as an independent work unit.
_Avoid_: concurrent execution (too vague — hides whether causal), parallel agents

**Capability Class**:
A coarse classification of a request's needed competence, defined by *tool/side-effect boundary* (not executor strength). Seven values: `code_edit | research | messaging | memory_ops | office_automation | conversation | general`. A complementary set is built by picking one executor per relevant class. Supersedes the legacy `TaskRouteIntent`, which was the index key of the disused affinity-scoring model and carried wrong granularity (no office/automation class; treated model-level `reasoning` as a routing class).
_Avoid_: intent (overloaded with the legacy intent router), domain (overloaded with executor profile domains), TaskRouteIntent, reasoning-as-a-class

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
The mechanism for running parallel executor sessions without mutual file interference. Each isolated task gets a dedicated `git worktree` (an independent working directory on its own branch, sharing the `.git` object store). Parallel tasks live in separate worktrees — physical isolation. Within a single worktree, only one executor session runs at a time — logical mutual exclusion, preventing dirty writes. Coordination of cross-task results happens at the orchestration layer (who waits for whom, how outputs pass), not inside the worktree.
_Avoid_: workspace lock, file locking (too weak — detects but doesn't prevent), sandbox (different concept)

**Estimated Cost Class**:
A prior, type-based cost band (`cheap | moderate | expensive`) used to decide whether spending tokens on a reviewer is justified. Derived from request type and estimated IO scale — *not* from historical statistics, so it cannot decay into a dead static value like the legacy `historicalSuccess`.
_Avoid_: token cost, budget, historical success
