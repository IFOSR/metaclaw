# Round 8 Web Link Materials Commercial V1 Implementation Plan

**Goal:** Let users include webpage links in natural-language task creation and have them stored as task materials.

## Round Goal

This round closes the PRD gap for manual web-link input:

- `https://...` links in natural-language task creation are auto-attached as materials
- local files and web links can coexist in the same task input
- links are preserved as links, not rewritten as local paths
- existing task view and prompt injection continue to work

## Acceptance Pack

- `examples/e2e/round-8-web-links/README.md`
- `examples/e2e/round-8-web-links/scripts/00-inline-web-links-smoke.txt`
- `examples/e2e/round-8-web-links/manual/01-create-task-with-inline-links.md`

## Key Constraints

- only support explicit `http://` and `https://` links in this round
- do not fetch page content in Metaclaw
- preserve existing file-material extraction behavior

