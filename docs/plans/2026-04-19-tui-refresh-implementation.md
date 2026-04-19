# TUI Refresh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refresh the Metaclaw terminal UI so users can clearly distinguish input, routing, executor progress, confirmation states, and final results without rewriting the current Ink architecture.

**Architecture:** Keep the existing single-column Ink app in `src/tui/app.tsx`, but add a semantic rendering layer that converts flat transcript lines into typed visual blocks. Update the composer and runtime summary to expose active execution state, then lock the behavior with focused TUI tests and real `codex-cli` end-to-end verification.

**Tech Stack:** TypeScript, React, Ink, Node test runner, real `codex-cli`

---

### Task 1: Baseline Semantic Rendering Tests

**Files:**
- Modify: `tests/tui/static-output.test.ts`
- Modify: `tests/tui/execution-progress.test.ts`
- Modify: `tests/tui/execution-indicator.test.ts`
- Modify: `tests/tui/guidance-panel.test.ts`
- Modify: `tests/tui/guidance-blocks.test.ts`

**Step 1: Write the failing assertions for semantic block rendering**

Add assertions that expect:
- user lines to retain a distinct `>` prefix block
- system lines to render with `→`
- executor detail lines to render with `·`
- result lines to render with `✓` or `!` headers where applicable
- status area to use numeric counts consistently

**Step 2: Run the targeted tests to verify they fail**

Run:

```bash
npm test -- tests/tui/static-output.test.ts tests/tui/execution-progress.test.ts tests/tui/execution-indicator.test.ts tests/tui/guidance-panel.test.ts tests/tui/guidance-blocks.test.ts
```

Expected:
- failures showing old raw-string rendering no longer matches the new semantic expectations

**Step 3: Keep the failures small and explicit**

Refine the expectations so each file validates one user-visible contract instead of broad full-screen snapshots.

**Step 4: Re-run the targeted tests**

Run the same command and confirm the suite still fails only on the new expectations.

**Step 5: Commit checkpoint**

```bash
git add tests/tui/static-output.test.ts tests/tui/execution-progress.test.ts tests/tui/execution-indicator.test.ts tests/tui/guidance-panel.test.ts tests/tui/guidance-blocks.test.ts
git commit -m "test: define tui semantic rendering expectations"
```

### Task 2: Add Semantic Block Rendering in the Ink App

**Files:**
- Modify: `src/tui/app.tsx`
- Test: `tests/tui/static-output.test.ts`
- Test: `tests/tui/execution-progress.test.ts`

**Step 1: Write the minimal rendering helpers**

Add small helpers in `src/tui/app.tsx` to classify committed output lines into render categories such as:

```ts
type OutputKind = 'user' | 'system' | 'context' | 'agent' | 'result' | 'warning';
```

and a helper shape such as:

```ts
interface RenderLine {
  kind: OutputKind;
  text: string;
}
```

**Step 2: Implement minimal classification rules**

Start with prefix and phrase-based classification for existing transcript lines, for example:
- lines beginning with `>` -> `user`
- lines beginning with `→` -> `system`
- lines beginning with `·` -> `context` or `agent`
- lines beginning with `✓` -> `result`
- lines beginning with `执行失败:` or warning markers -> `warning`

**Step 3: Render blocks with visual hierarchy**

Update the `Static` renderer so each line is drawn with:
- stable prefixes
- color by semantic kind
- indentation by kind

**Step 4: Run the targeted tests**

Run:

```bash
npm test -- tests/tui/static-output.test.ts tests/tui/execution-progress.test.ts
```

Expected:
- the semantic rendering tests pass

**Step 5: Commit checkpoint**

```bash
git add src/tui/app.tsx tests/tui/static-output.test.ts tests/tui/execution-progress.test.ts
git commit -m "feat: add semantic tui transcript rendering"
```

### Task 3: Upgrade Composer and Runtime Summary

**Files:**
- Modify: `src/tui/app.tsx`
- Modify: `tests/tui/execution-indicator.test.ts`
- Modify: `tests/tui/input-availability.test.ts`
- Modify: `tests/tui/guidance-panel.test.ts`

**Step 1: Write failing tests for composer status hints**

Add expectations for:
- `status: idle`
- `status: running codex-cli` or equivalent active executor label
- `status: waiting_confirm`
- numeric status counts only

**Step 2: Run the focused tests to verify failure**

Run:

```bash
npm test -- tests/tui/execution-indicator.test.ts tests/tui/input-availability.test.ts tests/tui/guidance-panel.test.ts
```

Expected:
- failures due to missing composer status text or old summary format

**Step 3: Implement minimal composer and summary changes**

In `src/tui/app.tsx`:
- add a lightweight composer status line
- normalize runtime summary into numeric-only counts
- keep the latest event as a single stable line

**Step 4: Run the focused tests again**

Run the same command and confirm it passes.

**Step 5: Commit checkpoint**

```bash
git add src/tui/app.tsx tests/tui/execution-indicator.test.ts tests/tui/input-availability.test.ts tests/tui/guidance-panel.test.ts
git commit -m "feat: improve tui composer and runtime summary"
```

### Task 4: Add Active Executor Feedback and Waiting State

**Files:**
- Modify: `src/tui/app.tsx`
- Modify: `tests/tui/execution-progress.test.ts`
- Modify: `tests/tui/task-result-aggregation.test.ts`

**Step 1: Write failing tests for waiting feedback**

Add expectations for:
- visible executor phase or latest step while running
- `正在等待执行器返回...` when the executor is active but no new visible output appears
- result block separation after completion

**Step 2: Run the focused tests to verify failure**

Run:

```bash
npm test -- tests/tui/execution-progress.test.ts tests/tui/task-result-aggregation.test.ts
```

Expected:
- failures showing the waiting indicator and result separation are not implemented yet

**Step 3: Implement minimal active feedback logic**

In `src/tui/app.tsx`:
- derive a visible active state from `runtimeState`
- render a waiting line when execution is active and recent transcript output is quiet
- ensure result headers remain visually separate from process lines

**Step 4: Run the focused tests again**

Run the same command and confirm it passes.

**Step 5: Commit checkpoint**

```bash
git add src/tui/app.tsx tests/tui/execution-progress.test.ts tests/tui/task-result-aggregation.test.ts
git commit -m "feat: surface active executor progress in tui"
```

### Task 5: Full TUI Regression Pass

**Files:**
- Test: `tests/tui/*.test.ts`

**Step 1: Run the entire TUI suite**

Run:

```bash
npm test -- tests/tui
```

Expected:
- all TUI tests pass

**Step 2: Fix any regressions with the smallest necessary changes**

Touch only the files implicated by the failing tests. Keep behavior aligned with the approved design.

**Step 3: Re-run the entire TUI suite**

Run the same command until it passes cleanly.

**Step 4: Commit checkpoint**

```bash
git add src/tui/app.tsx tests/tui
git commit -m "test: stabilize tui refresh behavior"
```

### Task 6: Real `codex-cli` End-to-End Validation

**Files:**
- Modify: `examples/e2e/README.md`
- Modify: `examples/trial-scenarios/README.md`
- Create or Modify: `examples/e2e/tui-refresh/README.md`

**Step 1: Prepare the acceptance pack**

Document real validation scenarios for:
- simple ask-response
- long-running research task
- high-priority interruption
- parked-task resume
- confirmation-required action

**Step 2: Run real end-to-end flows with `./metaclaw.sh start`**

Use real `codex-cli`, not sandbox mocks. Capture the visible TUI evidence for:
- input clarity
- active execution visibility
- result block readability

**Step 3: Update the acceptance docs with exact observed outcomes**

Record:
- scenario
- commands or prompts used
- expected visible behavior
- actual visible behavior

**Step 4: Run build and regression checks**

Run:

```bash
npm test
npm run build
```

Expected:
- both commands pass

**Step 5: Commit checkpoint**

```bash
git add examples/e2e/README.md examples/trial-scenarios/README.md examples/e2e/tui-refresh/README.md
git commit -m "docs: add tui refresh acceptance coverage"
```

### Task 7: Final Ship Review

**Files:**
- Modify: `README.md`
- Modify: `docs/metaclaw-os_tui_spec_v1.md`

**Step 1: Update product-facing TUI description**

Document the new terminal behavior:
- semantic transcript hierarchy
- composer status hints
- active executor feedback
- result blocks

**Step 2: Run one final regression pass**

Run:

```bash
npm test
npm run build
```

Expected:
- both commands pass after doc alignment

**Step 3: Commit final checkpoint**

```bash
git add README.md docs/metaclaw-os_tui_spec_v1.md
git commit -m "docs: align tui spec with refreshed terminal ui"
```
