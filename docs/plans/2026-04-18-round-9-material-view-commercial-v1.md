# Round 9 Material View Commercial V1 Implementation Plan

**Goal:** Make task materials readable in the task view by separating local files and web links.

## Round Goal

This round improves the task workspace presentation:

- task detail separates local files from web links
- blocked tasks with existing links show a clearer resume hint
- executor prompt keeps materials readable instead of flattening everything into one line

## Acceptance Pack

- `examples/e2e/round-9-material-view/README.md`
- `examples/e2e/round-9-material-view/scripts/00-material-view-smoke.txt`
- `examples/e2e/round-9-material-view/manual/01-task-view-splits-files-and-links.md`

## Key Constraints

- no new material type beyond file/link
- no page fetching or link preview generation
- keep task state and scheduler logic unchanged

