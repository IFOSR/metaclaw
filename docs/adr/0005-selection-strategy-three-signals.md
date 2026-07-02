---
status: proposed
---

# Executor selection: three quantifiable signals, LLM-decided

## Context

When a subtask's required `CapabilityClass` is satisfied by more than one available executor (e.g. `code_edit` → codex-cli / claude-code / deepseek-tui), the router must pick a primary. The legacy approach scored executors with a static `historicalSuccess` seed (ADR-0001 abolishes it). A new, non-static selection signal is needed.

The user's positioning: this is an open-source project for individual users. Selection among same-class executors uses basic, hard-quantifiable logic — "the most preliminary intelligence." A more data-rich efficiency/robustness/quality routing strategy is an enterprise (paid) concern, out of scope for the project, documented only as an advanced option (e.g. in README).

## Decision

The routing **tool layer** provides three signals per candidate executor. The **LLM** — not the tool layer — decides how to combine them to pick a primary.

1. **Recent success rate.** Each candidate executor's success rate over its last 3 tasks. Source: `executor_route_events.result` aggregated per `selected_executor`, ordered by `created_at DESC LIMIT 3`. Higher success rate preferred.
2. **Pending load.** Each candidate executor's count of currently queued/running tasks (from the task table, status in `running`/pending). Less-loaded executor preferred.
3. **Price.** Per-executor cost. Used as a tiebreaker when the first two signals are close: prefer the cheaper executor.

**Provenance of the signals:** signals 1 and 2 are derivable from existing data — but with different levels of readiness.
- Signal 1 (success rate): `executor_route_events.result` + `selected_executor` are already written back after each execution. A per-executor aggregate query over the last 3 rows is all that's needed — data ready.
- Signal 2 (pending load): the data *exists* but is organized per-task, not per-executor. `TaskStatus` (`created`/`running`/`parked`/`blocked`/`done`) and `SchedulerEngine.queuedExecution` track queue/running state; `runningExecutorNameByTask` maps the running task to its executor. What's missing is a **single aggregation method** that groups these by executor name (e.g. `listTasksByExecutor`) — a thin query, not a new data model.
- Signal 3 (price): **no existing storage** — a new field/source is required. This is the one genuine new data dependency.

**Division of labor:** the tool layer's job is to fetch and present these three numbers per candidate. It does **not** compute a combined score or rank. The LLM receives the candidates + their three signals and decides. This keeps the "intelligence" in the LLM (the project's reason for existing, per ADR-0003's spirit and the user's stance that regex/rule-based routing is unacceptable) and the tool layer a dumb provider — a clean boundary matching the "decision layer doesn't do concrete operations" principle.

## Considered Options

- **Static per-class affinity table (legacy `DEFAULT_INTENT_AFFINITY`).** Rejected: static, never written back, carries the wrong semantics (ADR-0002). Reintroducing it would undo the rewrite.
- **LLM also picks the executor by name from task nuance.** Rejected: this smuggles model-level capability (e.g. "deepseek is better at reasoning") back into routing, contradicting the decision that `CapabilityClass` is defined by tool/side-effect boundaries and that model-level differences are judged by the reviewer post-execution, not pre-selected by the router.
- **Tool layer computes a weighted score.** Rejected: that hardcodes the tradeoff weights, which the user wants the LLM to judge per-case. It would also re-create a static-feeling scoring model.

## Consequences

- `historicalSuccess` on `ExecutorProfile` is fully retired — `executor_route_events.result` is the live, written-back source for signal 1. No redundancy.
- Price data does not exist yet; introducing it is a prerequisite for signal 3. If absent, the tool layer reports "unknown" and the LLM falls back to signals 1 and 2 only.
- "Last 3 tasks" is a deliberately small window — cheap to aggregate, responsive to recent executor state, but statistically thin. This is acceptable for the open-source personal-user scope; the enterprise strategy (out of scope) would use larger windows and more dimensions.
- This ADR covers selection *within* a capability class. Complementary selection *across* classes (one executor per class) is the prior decision; this ADR governs only the "multiple executors qualify for the same class" tiebreak.
- The LLM-as-decider means selection is non-deterministic and not unit-testable as a pure function. Tests must instead verify the tool layer provides the correct three signals, and treat the LLM's weighing as a black box.
