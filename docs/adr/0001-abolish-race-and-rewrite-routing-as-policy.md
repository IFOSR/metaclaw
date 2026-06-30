---
status: proposed
---

# Abolish race_executors and rewrite routing as ExecutionPolicy

## Context

The legacy routing layer (`ExecutorRouter` + `ExecutionPlanningService`) scored executors using a static `historicalSuccess` value (seeded at startup, never written back) with weight 0.07 — meaning real quality never influenced selection. Its only multi-executor mode, `race_executors`, was hard-coded to run `pi-agent` + `hermes-agent` in parallel and declare the *first* to finish the winner, aborting the rest. The win criterion was speed, not quality, and every aborted run's tokens were wasted.

## Decision

1. **Delete `race_executors`** from the execution-mode union and remove its runtime branch (`resolveRuntimeExecutors` race path, `executeWithOptionalRace` parallel settle logic). The only modes that remain are `single_executor` and `multi_executor`.
2. **Replace `ExecutionPlanV2` with `ExecutionPolicy`**, adding quality and safety fields the old plan lacked: `isolationRequired`, `verificationLevel`, `reviewerExecutor`, `riskLevel`, `estimatedCostClass`, and a `fallbackChain` that replaces race as the quality-insurance mechanism.
3. **Select complementary executors, not redundant ones.** For `multi_executor`, pick one executor per relevant *capability class* (e.g. one coding agent + one office/automation agent), constrained by availability and customer subscription — never two agents from the same class racing.
4. **Scope the rewrite at the decision layer + plan shape (C2).** Runtime's single/multi mechanism stays; only the race branch and decision-layer evaluation are replaced. Session, storage, and gateway layers are untouched.

## Considered Options

- **C1 — keep the plan shape, swap only the decision internals.** Rejected: the old `ExecutionPlanV2` has no fields for verification, isolation, or risk, so quality-aware routing could not be expressed.
- **C3 — also rewrite the runtime's execution model.** Rejected: the single/multi runtime is sound; only the race branch is diseased. Touching it widens blast radius without addressing the root cause.

## Consequences

- `fallbackChain` is sequential — a failed primary adds latency before the next executor runs. This is the deliberate cost of not wasting tokens on racing.
- The `historicalSuccess` field and its dead-weight scoring disappear. **Correction (verified 2026-06-25):** outcome data is *not* absent from the system — the `executor_route_events` table records every dispatch's `result` (`success` / `failed:...` / `blocked:...`) and is written back via `markRouteEventResult` after each execution. What was missing was not the data, but a consumer: nothing read these outcomes back to influence selection. The new selection strategy (ADR-0005) consumes exactly this data. So "no outcome-based learning" was inaccurate as a blanket statement — the data existed unused; ADR-0005 makes it the primary selection signal and retires `historicalSuccess` as redundant.
- Several tests reference `race_executors` (`execution-runtime.test.ts`, `intent-orchestrator.test.ts`, `intent-golden.test.ts`) and must be removed or rewritten.
