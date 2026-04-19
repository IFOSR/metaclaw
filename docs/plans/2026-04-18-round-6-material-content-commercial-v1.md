# Round 6 Material Content Commercial V1 Implementation Plan

**Goal:** Make attached materials actually useful to the executor by injecting small text excerpts into the execution context.

## Round Goal

This round closes the gap between "materials are attached" and "materials can influence the result":

- readable text materials should inject short excerpts into the executor context
- binary / unsupported files should still remain visible as paths only
- executor prompt must clearly separate material paths from material content excerpts
- task continuity and scheduler behavior must remain unchanged

## Acceptance Pack

- `examples/e2e/round-6-material-content/README.md`
- `examples/e2e/round-6-material-content/scripts/00-material-content-smoke.txt`
- `examples/e2e/round-6-material-content/manual/01-text-materials-influence-result.md`

## Key Constraints

- no file-content parsing for PDF/image in this round
- no new storage subsystem
- keep injection bounded and readable
- use deterministic, rule-based text extraction only

