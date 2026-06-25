---
status: proposed
---

# CapabilityClass supersedes TaskRouteIntent

## Context

The legacy routing layer classified requests with `TaskRouteIntent` (`repo_execution | technical_reasoning | research_workflow | memory_agent_ops | conversation_or_control | general`). This type was the index key of the `DEFAULT_INTENT_AFFINITY` table — the scoring model ADR-0001 abolishes. It also carried wrong granularity: the routing design now calls for an `office_automation` class, which `TaskRouteIntent` never had (the need was misfiled under `memory_agent_ops` or `general`). Reusing it would make the new mechanism read as "same model, renamed."

## Decision

Introduce a new `CapabilityClass` enum, designed for complementary executor selection, decoupled from `TaskRouteIntent`. The `TaskRouteIntent` type and its affinity table are retired as part of the routing rewrite (ADR-0001). No alias bridge is built — the old type is removed, not shimmed.

## Considered Options

- **A — reuse `TaskRouteIntent`, change only its use.** Rejected: it is bound to the disused affinity-scoring model and lacks the `office_automation` class the new selection principle requires. Reuse would carry the wrong semantics.
- **C — rename/refactor `TaskRouteIntent` into `CapabilityClass` with an alias.** Rejected: an alias bridge keeps the dead affinity semantics alive in the type system and invites gradual, invisible drift back to the old model.

## Consequences

- `TaskRouteIntent` is referenced across 10 files, 32 occurrences (decision layer, storage repos, LLM bridge, tests). All must migrate to `CapabilityClass`; there is no compatibility shim, so this is a coordinated change, not a rename.
- `CapabilityClass` values must be chosen deliberately — they define which executors are "complementary" (one per class) versus "redundant" (same class). Getting the class boundaries wrong breaks the entire selection principle. The concrete enum values are decided in a subsequent step.
- Customer-subscription and availability constraints attach to executor selection per class; their representation is decided separately.
