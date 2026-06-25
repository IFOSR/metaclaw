---
status: proposed
---

# Classification via LLM, reusing the existing semantic bridge

## Context

The router must map a work unit to `CapabilityClass`. Options were regex matching, LLM classification, or rules+LLM-fallback. The user chose **LLM** outright: this is MetaClaw's reason for existing — the decision layer's job is to allocate by understanding the user's need, and regex is unacceptable because many tasks require decomposition (a separate skill, future). The decomposition-skill guidance is itself future work.

Investigation shows the LLM path already exists: `SemanticIntentRouter.decide` already calls `llmBridge.query` with a built prompt ([semantic-intent-router.ts:141-148](src/core/semantic-intent-router.ts#L141)), and `IntentOrchestrator` consumes it. So this is **not** building an LLM classifier from scratch — it is repurposing the existing one to emit `CapabilityClass` instead of `TaskRouteIntent`.

## Decision

1. **Classification is LLM-driven, via the existing `llmBridge`.** The semantic router's prompt and output schema are changed to produce `CapabilityClass` (ADR-0008) instead of `TaskRouteIntent`. No regex-first stage; the LLM is the classifier. (Regex remains only where it is appropriate — failure classification, ADR-0006 — not intent classification.)

2. **The classifier consumes a work unit, not raw input.** Per ADR-0003, the router's input is a work unit (today: a flat `Task`). When the decomposition skill exists, it will feed richer work units; the classifier's contract is stable either way.

3. **Decomposition is out of scope here.** The classifier classifies one work unit into capability class(es); it does not split a request into multiple work units. Decomposition is a separate future skill. The output *shape* of the classifier (single class vs primary+auxiliary vs multi-class) is **deferred** — it depends on the decomposition structure, which is the routing layer's most complex part and is explicitly not fixed now.

## Considered Options

- **Rules + LLM fallback (regex first, LLM only when unsure).** Rejected by the user: regex-based routing is unacceptable as a primary path because many tasks need decomposition that rules cannot do. The LLM is the classifier, full stop.
- **Build a new LLM classifier from scratch.** Rejected: `SemanticIntentRouter` already queries the LLM. Repurposing it avoids a second LLM path and keeps one classifier in the codebase.
- **Fix the output shape now (single vs primary+aux vs multi-class).** Rejected/deferred: the shape depends on decomposition structure (causal chains, async dependencies) — the most complex part of the routing layer. Prematurely fixing it risks designing the wrong thing. The shape is decided when the decomposition-DAG design is done.

## Consequences

- The classifier is non-deterministic and not a pure function; tests verify the prompt/schema wiring and the work-unit-in/`CapabilityClass`-out contract, treating the LLM as a black box.
- The deferred output shape is a **known gap**: until decomposition lands, a multi-capability work unit (e.g. "research X then code Y") is handled as a sequence of separate work units across turns, each classified singly. This is the same gap ADR-0003 acknowledges.
- Because classification reuses the existing `llmBridge`, the token cost of classification is the existing semantic-router cost — not a new budget line. (This aligns with the race-abolition cost motivation: classification's token cost is far below what race wasted.)
- The `TaskRouteIntent` type, once the classifier emits `CapabilityClass`, has no producer left and is removed per ADR-0002 (no shim).
