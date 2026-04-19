# Round 2 Guidance Commercial V1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the Round 2 commercial V1 guidance gaps by making proactive task guidance visible, throttled, and consistent across startup, completion, unblock, and idle moments.

**Architecture:** Keep `OrchestrationEngine` responsible for priority scoring and suggestion generation, then extend `MetaclawSession` with a lightweight reminder runtime that decides when to surface guidance blocks. Preserve the current transcript-first TUI, but add stable, structured guidance output instead of ad hoc reminder lines.

**Tech Stack:** TypeScript, Ink, React, better-sqlite3, Vitest

---

## Round Goal

This round must make the PRD guidance promise user-visible without rebuilding the scheduler:

- startup guidance must clearly show the current situation
- completion and unblock flows must proactively suggest what to do next
- idle reminders must exist and respect throttle
- repeated reminders must be suppressed
- guidance must explain `why this task, why now`

## Acceptance Pack

Before implementation, use the Round 2 acceptance pack in:

- `examples/e2e/round-2-guidance/README.md`
- `examples/e2e/round-2-guidance/scripts/00-dashboard-and-suggestion-smoke.txt`
- `examples/e2e/round-2-guidance/manual/01-startup-and-completion-guidance.md`
- `examples/e2e/round-2-guidance/manual/02-idle-reminder-and-throttle.md`
- `examples/e2e/round-2-guidance/manual/03-unblock-and-resume-guidance.md`

These scenarios are the release-grade acceptance criteria for this round.

---

### Task 1: Add Guidance Acceptance Coverage First

**Files:**
- Create: `examples/e2e/round-2-guidance/README.md`
- Create: `examples/e2e/round-2-guidance/scripts/00-dashboard-and-suggestion-smoke.txt`
- Create: `examples/e2e/round-2-guidance/manual/01-startup-and-completion-guidance.md`
- Create: `examples/e2e/round-2-guidance/manual/02-idle-reminder-and-throttle.md`
- Create: `examples/e2e/round-2-guidance/manual/03-unblock-and-resume-guidance.md`

**Step 1: Write the acceptance pack**

Document the real user scenarios before touching implementation:

- startup dashboard guidance
- task completion suggestion
- idle reminder behavior
- throttle preventing repeated reminders
- unblock and resume guidance
- explanation quality for each suggestion

**Step 2: Verify scenarios are runnable from current repo structure**

Run:

```bash
find examples/e2e/round-2-guidance -maxdepth 3 -type f | sort
```

Expected: all Round 2 acceptance files exist.

**Step 3: Commit**

```bash
git add examples/e2e/round-2-guidance docs/plans/2026-04-18-round-2-guidance-commercial-v1.md
git commit -m "docs: add round 2 guidance acceptance pack"
```

### Task 2: Add Reminder Runtime State And Throttle

**Files:**
- Modify: `src/session/metaclaw-session.ts`
- Modify: `src/core/types.ts`
- Modify: `src/utils/config.ts`
- Test: `tests/session/guidance-round2-acceptance.test.ts`
- Create: `tests/tui/idle-reminder.test.ts`

**Step 1: Write the failing tests**

Add tests for:

- idle reminder appears when there are actionable suggestions and the user is inactive
- reminder does not appear if `reminder_enabled` is false
- reminder is throttled and not re-emitted inside the configured interval
- reminder can reappear after throttle expires if the state is still actionable

**Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/session/guidance-round2-acceptance.test.ts tests/tui/idle-reminder.test.ts
```

Expected: FAIL because no reminder runtime currently consumes `reminder_enabled` or `reminder_throttle`.

**Step 3: Write minimal implementation**

Add a lightweight reminder runtime inside `MetaclawSession`:

- track last reminder time and last reminder fingerprint
- evaluate guidance opportunities after meaningful state changes
- surface idle reminders only when:
  - reminders are enabled
  - the throttle window has passed
  - there is at least one actionable suggestion
- keep the logic local to session runtime; do not add a daemon

**Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/session/guidance-round2-acceptance.test.ts tests/tui/idle-reminder.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/session/metaclaw-session.ts src/core/types.ts src/utils/config.ts tests/session/guidance-round2-acceptance.test.ts tests/tui/idle-reminder.test.ts
git commit -m "feat: add throttled session guidance reminders"
```

### Task 3: Standardize Guidance Blocks For Startup, Completion, And Unblock

**Files:**
- Modify: `src/core/orchestration.ts`
- Modify: `src/session/metaclaw-session.ts`
- Modify: `src/commands/global-commands.ts`
- Test: `tests/core/orchestration.test.ts`
- Create: `tests/tui/guidance-blocks.test.ts`

**Step 1: Write the failing tests**

Add tests for:

- startup dashboard includes a clear guidance block for the best current task
- task completion emits a structured next-step suggestion with reasons
- unblock emits a proactive resume suggestion with reasons
- recovered preempted tasks surface a stronger continuity explanation

**Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/core/orchestration.test.ts tests/tui/guidance-blocks.test.ts
```

Expected: FAIL because current guidance is present but not standardized across lifecycle events.

**Step 3: Write minimal implementation**

Normalize guidance output into stable blocks:

- startup guidance
- completion guidance
- unblock guidance
- resume-after-preemption guidance

Each block must include:

- recommended action
- concise reasons
- task identifier

**Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/core/orchestration.test.ts tests/tui/guidance-blocks.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/core/orchestration.ts src/session/metaclaw-session.ts src/commands/global-commands.ts tests/core/orchestration.test.ts tests/tui/guidance-blocks.test.ts
git commit -m "feat: standardize proactive guidance blocks"
```

### Task 4: Improve TUI Commercial Guidance Presentation

**Files:**
- Modify: `src/tui/app.tsx`
- Test: `tests/tui/execution-indicator.test.ts`
- Test: `tests/tui/static-output.test.ts`
- Create: `tests/tui/guidance-panel.test.ts`

**Step 1: Write the failing tests**

Add tests asserting:

- runtime summary remains stable while guidance blocks are added
- guidance output is visually separate from executor logs and task results
- reminder lines do not remount the whole transcript on every update

**Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/tui/execution-indicator.test.ts tests/tui/static-output.test.ts tests/tui/guidance-panel.test.ts
```

Expected: FAIL because guidance is still just transcript text and not a stable commercial-grade presentation layer.

**Step 3: Write minimal implementation**

Add a compact guidance presentation area that preserves the current TUI architecture:

- keep transcript history static
- render structured guidance blocks consistently
- ensure the runtime summary remains readable

Do not introduce a large component refactor in this round.

**Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/tui/execution-indicator.test.ts tests/tui/static-output.test.ts tests/tui/guidance-panel.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/tui/app.tsx tests/tui/execution-indicator.test.ts tests/tui/static-output.test.ts tests/tui/guidance-panel.test.ts
git commit -m "feat: improve tui guidance presentation"
```

### Task 5: Validate Round 2 With Scripted And Manual E2E

**Files:**
- Modify: `examples/e2e/round-2-guidance/README.md`
- Modify: `README.md`

**Step 1: Run targeted regression**

Run:

```bash
npm test -- tests/session/guidance-round2-acceptance.test.ts tests/tui/idle-reminder.test.ts tests/tui/guidance-blocks.test.ts tests/tui/guidance-panel.test.ts
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

**Step 3: Run scripted acceptance**

Run:

```bash
METACLAW_HOME=/tmp/metaclaw-round2 node dist/index.js --script examples/e2e/round-2-guidance/scripts/00-dashboard-and-suggestion-smoke.txt
```

Expected: PASS-like transcript showing startup dashboard, task completion suggestion, and dashboard output.

**Step 4: Run manual acceptance**

Execute:

- `examples/e2e/round-2-guidance/manual/01-startup-and-completion-guidance.md`
- `examples/e2e/round-2-guidance/manual/02-idle-reminder-and-throttle.md`
- `examples/e2e/round-2-guidance/manual/03-unblock-and-resume-guidance.md`

Expected: all Round 2 guidance acceptance expectations are satisfied in the real TUI.

**Step 5: Commit**

```bash
git add examples/e2e/round-2-guidance README.md
git commit -m "docs: document round 2 guidance verification flow"
```

---

## Round 2 Exit Criteria

Round 2 is complete only if all of the following are true:

- startup guidance clearly tells the user what to do next
- completion, unblock, and resume flows proactively surface the next action
- idle reminders exist and are throttled
- reminders respect user config
- guidance always includes clear reasons
- all Round 2 tests pass
- scripted and manual Round 2 acceptance scenarios are ready for final user validation
