# Round 7 Inline Materials Commercial V1 Implementation Plan

**Goal:** Let users create a task and attach local file materials in one natural-language input.

## Round Goal

This round closes the remaining PRD gap for material input:

- a natural-language task can include local file paths directly
- Metaclaw extracts valid local file paths and stores them as task resources
- the task still reads like a task, not a path dump
- executor context automatically gets those resources and text excerpts through the existing Round 6 path

## Acceptance Pack

- `examples/e2e/round-7-inline-materials/README.md`
- `examples/e2e/round-7-inline-materials/scripts/00-inline-materials-smoke.txt`
- `examples/e2e/round-7-inline-materials/manual/01-create-task-with-inline-files.md`

## Key Constraints

- only support local file paths in this round
- no new upload subsystem
- preserve existing task routing and scheduler behavior
- prefer deterministic path extraction over LLM guessing

