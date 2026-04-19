# Round 5 Material Loop Commercial V1 Implementation Plan

**Goal:** Close the material-loop gap in the commercial V1 without changing the scheduler or executor architecture.

## Round Goal

This round focuses on the lowest-cost but user-visible material workflow gaps:

- `/attach` must support attaching more than one file in a single command
- `/attach` must support explicit task targeting after restart or when there is no current task
- attaching materials to a blocked task must tell the user how to resume it
- task view must continue to show the full material list after attach operations

## Acceptance Pack

- `examples/e2e/round-5-material-loop/README.md`
- `examples/e2e/round-5-material-loop/scripts/00-attach-multiple-materials.txt`
- `examples/e2e/round-5-material-loop/manual/01-attach-to-current-task.md`
- `examples/e2e/round-5-material-loop/manual/02-attach-to-blocked-task-by-id.md`

## Key Constraints

- Keep the current command router and scheduler backbone
- Do not redesign task storage
- Do not introduce file-content ingestion in this round
- Focus on command correctness, task continuity, and user-visible recovery hints

