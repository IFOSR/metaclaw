---
status: proposed
---

# Router consumes subtasks, not raw user input

## Context

MetaClaw's decision layer has two distinct responsibilities: (1) decompose a user request into actionable pieces, and (2) decide which executor runs each piece. Today these are conflated — `SessionIntentApplicationService.createAndPrepareTask` takes raw user input and produces exactly one `Task` with a one-to-one binding. No decomposition step exists; the `Task` model is flat (no `parentId` / subtask fields), and `IntentDecisionV2` carries a single task binding, not a decomposition.

The user has stated that task decomposition is a future capability ("we'll write skills to guide it") and is distinct from routing. Conflating it with routing would force the router to own both understanding (hard, skill-driven) and dispatch (more deterministic), coupling two concerns with different stability profiles.

## Decision

Decouple decomposition from routing. The router consumes **subtasks** — single, already-decomposed pieces of work with a clear goal and required capability — and produces one `ExecutionPolicy` per subtask. The router does not decompose; decomposition is a separate upstream step (not yet built) that will eventually feed subtasks to the router.

The router's input contract is therefore: one subtask in, one `ExecutionPolicy` out. It never assumes a raw user string, never splits one input into multiple policies.

## Considered Options

- **B — merge decomposition and routing into one decision step.** Rejected: decomposition needs a dedicated skill and has a different stability profile than dispatch. Merging couples them and makes the router carry understanding complexity it shouldn't own.
- **C — defer the positioning; build the router on raw-input-to-single-policy for now.** Rejected: this bakes the raw-input assumption into the router's contract. When the decomposition skill lands, the router's input shape would have to change — a costlier reversal than designing for subtasks now.

## Consequences

- "subtask" is a concept without a dedicated data carrier today — the flat `Task` stands in. When decomposition is built, subtasks may gain a distinct type or a parent/child `Task` structure; the router's contract stays stable either way.
- The decomposition skill is explicitly out of scope for this routing rewrite. It is a prerequisite only in the sense that richer subtasks will flow once it exists; the router works on today's flat tasks immediately.
- A request that genuinely needs decomposition (e.g. "research X, then code Y, then notify") is, for now, handled as a sequence of separate subtasks across turns, not as one router call producing multiple policies.
