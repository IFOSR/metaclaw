# Round 4 Task View Commercial V1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the Round 4 commercial V1 gaps by turning task details and execution results into a real task view instead of a loose transcript of executor output.

**Architecture:** Keep the current task/session/executor backbone. Add a thin task-view aggregation layer on top of persisted task state, snapshots, materials, interaction history, and scheduling metadata. Do not replace the scheduler or executor adapters.

**Tech Stack:** TypeScript, Ink, React, better-sqlite3, Vitest

---

## Round Goal

This round must make the PRD task-view promise user-visible without a rewrite:

- `/task <id>` must read like a real task object, not a debug dump
- task results must aggregate into a stable summary and next-step view
- materials, block reasons, and latest outputs must be visible from the task view
- users must be able to understand what happened to a task without reading raw executor logs

## Acceptance Pack

Before implementation, use the Round 4 acceptance pack in:

- `examples/e2e/round-4-task-view/README.md`
- `examples/e2e/round-4-task-view/scripts/00-task-view-smoke.txt`
- `examples/e2e/round-4-task-view/manual/01-task-detail-shows-workspace-state.md`
- `examples/e2e/round-4-task-view/manual/02-result-aggregation-and-next-step.md`
- `examples/e2e/round-4-task-view/manual/03-material-and-block-recovery-view.md`

These scenarios are the release-grade acceptance criteria for this round.

---

### Task 1: Add Task-View Acceptance Coverage First

**Files:**
- Create: `examples/e2e/round-4-task-view/README.md`
- Create: `examples/e2e/round-4-task-view/scripts/00-task-view-smoke.txt`
- Create: `examples/e2e/round-4-task-view/manual/01-task-detail-shows-workspace-state.md`
- Create: `examples/e2e/round-4-task-view/manual/02-result-aggregation-and-next-step.md`
- Create: `examples/e2e/round-4-task-view/manual/03-material-and-block-recovery-view.md`

**Step 1: Write the acceptance pack**

Document the real user scenarios before touching implementation:

- `/task <id>` shows what this task is, current state, latest result, latest next step, and materials
- task completion results aggregate into a stable summary instead of forcing users to parse logs
- blocked tasks show missing materials / block reason and recovery path
- resumed tasks show latest snapshot and latest output together

**Step 2: Verify scenarios are runnable from current repo structure**

Run:

```bash
find examples/e2e/round-4-task-view -maxdepth 3 -type f | sort
```

Expected: all Round 4 acceptance files exist.

**Step 3: Commit**

```bash
git add examples/e2e/round-4-task-view docs/plans/2026-04-18-round-4-task-view-commercial-v1.md
git commit -m "docs: add round 4 task-view acceptance pack"
```

### Task 2: Add Failing Coverage For Task Detail As A Real Task View

**Files:**
- Modify: `tests/commands/task-commands-detail.test.ts`
- Create: `tests/session/task-view-round4-acceptance.test.ts`

**Step 1: Write the failing tests**

Add tests for:

- `/task <id>` shows structured sections for state, latest result, latest next step, materials, and blockers
- completed tasks show the latest aggregated result summary and next recommendation
- blocked tasks show the unresolved blocker and attached material list
- resumed tasks show both latest snapshot guidance and latest task result

**Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/commands/task-commands-detail.test.ts tests/session/task-view-round4-acceptance.test.ts
```

Expected: FAIL because the current task detail is still a linear metadata dump and does not aggregate the latest task workspace state.

**Step 3: Write minimal implementation**

Upgrade task detail rendering to a stable textual task view:

- task identity
- current status and explanation
- latest result summary
- latest next step
- latest blocker / recovery hint
- material list
- latest executor and latest scheduling info

Use existing task fields, snapshots, and interactions; do not add a new storage subsystem in this round.

**Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/commands/task-commands-detail.test.ts tests/session/task-view-round4-acceptance.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/task-commands.ts src/session/metaclaw-session.ts tests/commands/task-commands-detail.test.ts tests/session/task-view-round4-acceptance.test.ts
git commit -m "feat: turn task detail into a structured task view"
```

### Task 3: Aggregate Executor Results Into Stable Task-Level Output

**Files:**
- Modify: `src/session/metaclaw-session.ts`
- Modify: `src/core/types.ts`
- Test: `tests/tui/execution-progress.test.ts`
- Create: `tests/tui/task-result-aggregation.test.ts`

**Step 1: Write the failing tests**

Add tests asserting:

- task completion surfaces a compact result summary block
- raw executor logs remain available in transcript but are no longer the only task result surface
- if the executor returns a long answer, the task view keeps a readable summary and next step

**Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/tui/execution-progress.test.ts tests/tui/task-result-aggregation.test.ts
```

Expected: FAIL because current results still primarily render as transcript output.

**Step 3: Write minimal implementation**

Add a lightweight task-result aggregation layer:

- keep storing raw output in interactions
- derive a readable task summary and next-step surface for the latest task view
- show a compact completion block users can trust

Keep this rule-based and incremental. Do not add LLM post-processing in this round.

**Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/tui/execution-progress.test.ts tests/tui/task-result-aggregation.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/session/metaclaw-session.ts src/core/types.ts tests/tui/execution-progress.test.ts tests/tui/task-result-aggregation.test.ts
git commit -m "feat: aggregate executor results into task-level output"
```

### Task 4: Validate Round 4 With Scripted And Manual E2E

**Files:**
- Modify: `examples/e2e/round-4-task-view/README.md`
- Modify: `README.md`

**Step 1: Run targeted regression**

Run:

```bash
npm test -- tests/commands/task-commands-detail.test.ts tests/session/task-view-round4-acceptance.test.ts tests/tui/task-result-aggregation.test.ts
```

Expected: PASS

**Step 2: Run full regression**

Run:

```bash
npm run lint
npm test
npm run build
```

Expected: PASS

**Step 3: Run scripted smoke**

Run:

```bash
METACLAW_HOME=/tmp/metaclaw-round4 node dist/index.js --script examples/e2e/round-4-task-view/scripts/00-task-view-smoke.txt
```

Expected:

- task created and completed
- `/task <id>` shows readable state, result, next step, and materials
- blocked or resumed examples show blocker/material context instead of just executor transcript

**Step 4: Manually verify the acceptance pack**

Run the three manual scenarios in `examples/e2e/round-4-task-view/manual/`.

**Step 5: Commit**

```bash
git add README.md examples/e2e/round-4-task-view
git commit -m "test: validate round 4 task-view workflows"
```
