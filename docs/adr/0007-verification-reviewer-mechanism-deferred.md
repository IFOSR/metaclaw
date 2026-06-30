---
status: deferred
---

# Verification / reviewer mechanism (deferred, with design refinements recorded)

## Context

The routing rewrite introduced a `verificationLevel` field (`none | compile | test | review`) and a `reviewerExecutor` on `ExecutionPolicy`. The question was *when* a separate reviewer executor is dispatched to verify a primary's result, and *who* that reviewer is. Investigation of the current code showed:

- Existing verification is self-reported and weak: `HeuristicVerifier` checks only that output is non-empty; `TestEvidenceVerifier` regex-matches phrases like "测试通过" in the executor's own output. An executor can falsely claim success and pass — exactly the failure mode GitHub issue #69994 warns about (ADR-0004).
- There is **no** `reviewerExecutor` concept today — no dispatch of a *different* executor to re-check.
- "High-risk action detection" exists (`isRiskyExternalActionInstruction`, `safety-scanner`), but it routes to *user confirmation*, not to a reviewer. The hook mechanism needed to trigger review at high-risk action points (commit-to-remote, Feishu send, high-risk doc edit) **does not exist yet** — current "hooks" are Feishu webhooks, not pre/post-execution intercepts.

## Decision (recorded as design, implementation deferred)

This entire mechanism is **deferred**. Two specific design refinements are recorded now so the intent is not lost:

1. **Code-class tasks get a reviewer; the reviewer is NOT fixed.** A `code_edit` task, on completion, dispatches a separate executor to review. The reviewer is chosen the same way the primary executor is — by the three selection signals (availability / pending-load / price, ADR-0005), falling through to the next same-class candidate. There is no single "全能 reviewer" pinned to one executor. (Earlier draft proposed a fixed reviewer like pi or claude-code; this is revised.)

2. **Other risks are returned to the user, not sent to a reviewer.** Risks beyond code-class (high-risk external actions) need no dedicated reviewer executor. The plan: design a trigger hook (assessed as not difficult) that, on a high-risk action, suspends the task and returns the result to the MetaClaw console for **user** review. No审核器 is built for these.

## Gaps to fill before this can be un-deferred

- **`TaskStatus` has no "pending review" state.** Current statuses: `created / ready / running / parked / blocked / done / archived / cancelled` ([types.ts:2-11](src/core/types.ts#L2)). Neither `blocked` (failure/obstacle) nor `parked` (suspended) carries the "completed-but-awaiting-human-confirmation" semantics. A new status (e.g. `pending_review`) and its valid transitions must be added.
- **The execution hook mechanism does not exist.** Pre/post-execution intercepts that can trigger review at high-risk action points must be built. Existing "hooks" are Feishu webhooks — unrelated.
- **Reviewer selection reuses ADR-0005's three signals.** No new selection logic; the same signal-provider + LLM-decided path applies, restricted to same-class candidates different from the primary.

## Considered Options (for the reviewer-choosing sub-decision)

- **Fixed全能 reviewer (pi / claude-code).** Rejected: reintroduces a hardcoded special role, contradicting the dynamic-signal selection of ADR-0005. Also brittle if the fixed reviewer is unavailable.
- **LLM judges risk to decide review.** Rejected by the user: LLM cannot reliably judge risk; risk triggers must be explicit rules/hooks, not semantic guesses.

## Consequences

- Until un-deferred, `verificationLevel` may default to `none`/`test` (existing self-verification), and `reviewerExecutor` is unused. The #69994 "false success" gap is **not yet closed** — it is closed only when this ADR is implemented.
- Deferral is acceptable because the rest of the routing rewrite (ADR-0001 through 0006) does not depend on the reviewer; it depends only on `ExecutionPolicy` having the fields, which the shape reserves.
- When implemented, the high-risk path does **not** add a reviewer executor — it adds a hook + a `pending_review` status + user-console return. The code-class path adds reviewer dispatch via ADR-0005 signals. These are two distinct mechanisms; conflating them is a risk to flag during implementation.
