# Round 3 Task Boundary Commercial V1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the Round 3 commercial V1 task-boundary gaps by making ordinary conversation stay out of the task system while allowing conversation-derived follow-up work to become a proper durable task with the right context.

**Architecture:** Keep the current `LlmBridge -> route -> intent -> session dispatch` backbone. Add narrow, focus-aware guardrails in `MetaclawSession` and `session-helpers` so the system can distinguish `conversation continuation`, `conversation-derived actionable work`, and `explicit task control` without replacing the scheduler or the existing task model.

**Tech Stack:** TypeScript, Ink, React, better-sqlite3, Vitest

---

## Round Goal

This round must make the PRD task-boundary promise user-visible without rebuilding routing:

- ordinary conversation must not create durable tasks
- short continuation prompts like `继续` / `展开` must stay in conversation mode
- actionable follow-up based on the current conversation must create a new durable task instead of reviving an unrelated parked task
- conversation-derived follow-up work must inherit the recent conversation context so the executor can actually act on it
- `/tasks` must remain a task list, not a transcript dump

## Acceptance Pack

Before implementation, use the Round 3 acceptance pack in:

- `examples/e2e/round-3-task-boundary/README.md`
- `examples/e2e/round-3-task-boundary/scripts/00-conversation-follow-up-smoke.txt`
- `examples/e2e/round-3-task-boundary/manual/01-conversation-does-not-create-task.md`
- `examples/e2e/round-3-task-boundary/manual/02-conversation-follow-up-becomes-task.md`
- `examples/e2e/round-3-task-boundary/manual/03-conversation-focus-beats-old-parked-task.md`

These scenarios are the release-grade acceptance criteria for this round.

---

### Task 1: Add Task-Boundary Acceptance Coverage First

**Files:**
- Create: `examples/e2e/round-3-task-boundary/README.md`
- Create: `examples/e2e/round-3-task-boundary/scripts/00-conversation-follow-up-smoke.txt`
- Create: `examples/e2e/round-3-task-boundary/manual/01-conversation-does-not-create-task.md`
- Create: `examples/e2e/round-3-task-boundary/manual/02-conversation-follow-up-becomes-task.md`
- Create: `examples/e2e/round-3-task-boundary/manual/03-conversation-focus-beats-old-parked-task.md`

**Step 1: Write the acceptance pack**

Document the real user scenarios before touching implementation:

- simple conversation and short continuation stay out of the task list
- a follow-up instruction like `把刚才那段分析整理成三点结论` becomes a new task
- a parked task already in the system must not steal a conversation-derived follow-up instruction
- the executor receives the recent conversation turns as context for the new follow-up task

**Step 2: Verify scenarios are runnable from current repo structure**

Run:

```bash
find examples/e2e/round-3-task-boundary -maxdepth 3 -type f | sort
```

Expected: all Round 3 acceptance files exist.

**Step 3: Commit**

```bash
git add examples/e2e/round-3-task-boundary docs/plans/2026-04-18-round-3-task-boundary-commercial-v1.md
git commit -m "docs: add round 3 task-boundary acceptance pack"
```

### Task 2: Add Failing Coverage For Conversation-Derived Follow-Up Work

**Files:**
- Modify: `tests/tui/conversation-routing.test.ts`
- Create: `tests/session/task-boundary-round3-acceptance.test.ts`

**Step 1: Write the failing tests**

Add tests for:

- conversation-derived actionable follow-up creates a new durable task even if route/intent LLM outputs are noisy
- the new task does not resume or mutate an old parked task
- the new task carries the recent conversation turns into the executor call
- ordinary conversation still does not create durable tasks

**Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/tui/conversation-routing.test.ts tests/session/task-boundary-round3-acceptance.test.ts
```

Expected: FAIL because current focus-aware routing only protects short continuation prompts and does not guard conversation-derived work against misbinding.

**Step 3: Write minimal implementation**

Extend the session layer with focused heuristics:

- detect `conversation-derived work` separately from `conversation continuation`
- when the current focus is conversation, prefer:
  - `conversation` for `继续 / 展开 / 再说说`
  - `durable_task` for `把刚才那段内容整理/保存/存档/改写/...`
- when a prompt is clearly conversation-derived work, do not let a stale parked task win via intent misclassification

Keep the logic local to `MetaclawSession` and `session-helpers`; do not add a new routing subsystem.

**Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/tui/conversation-routing.test.ts tests/session/task-boundary-round3-acceptance.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/session/metaclaw-session.ts src/session/session-helpers.ts tests/tui/conversation-routing.test.ts tests/session/task-boundary-round3-acceptance.test.ts
git commit -m "feat: align conversation follow-up routing with task boundaries"
```

### Task 3: Surface The Boundary Decision In The Product

**Files:**
- Modify: `src/session/metaclaw-session.ts`
- Modify: `src/tui/app.tsx`
- Test: `tests/tui/guidance-panel.test.ts`
- Create: `tests/tui/task-boundary-visibility.test.ts`

**Step 1: Write the failing tests**

Add tests asserting:

- when a conversation-derived follow-up becomes a task, the user sees a clear reason in the transcript or guidance panel
- when a short continuation stays in conversation mode, the UI does not imply a hidden task switch
- task visibility remains stable and does not mix transcript conversation with task counts

**Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/tui/guidance-panel.test.ts tests/tui/task-boundary-visibility.test.ts
```

Expected: FAIL because current UI shows routing outcomes indirectly, making this boundary hard to trust in real use.

**Step 3: Write minimal implementation**

Surface compact, commercial-grade boundary explanations:

- `按当前对话创建跟进任务`
- `延续当前对话，不恢复旧任务`

Keep the UI lightweight and avoid adding another large panel.

**Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/tui/guidance-panel.test.ts tests/tui/task-boundary-visibility.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/session/metaclaw-session.ts src/tui/app.tsx tests/tui/guidance-panel.test.ts tests/tui/task-boundary-visibility.test.ts
git commit -m "feat: explain task-boundary routing decisions in tui"
```

### Task 4: Validate Round 3 With Scripted And Manual E2E

**Files:**
- Modify: `examples/e2e/round-3-task-boundary/README.md`
- Modify: `README.md`

**Step 1: Run targeted regression**

Run:

```bash
npm test -- tests/tui/conversation-routing.test.ts tests/session/task-boundary-round3-acceptance.test.ts tests/tui/task-boundary-visibility.test.ts
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
METACLAW_HOME=/tmp/metaclaw-round3 node dist/index.js --script examples/e2e/round-3-task-boundary/scripts/00-conversation-follow-up-smoke.txt
```

Expected:

- first conversational prompt does not create a task
- short continuation still behaves like conversation
- follow-up instruction creates exactly one durable task
- `/tasks` shows the follow-up task instead of polluting the list with the conversation turns

**Step 4: Manually verify the acceptance pack**

Run the three manual scenarios in `examples/e2e/round-3-task-boundary/manual/`.

**Step 5: Commit**

```bash
git add README.md examples/e2e/round-3-task-boundary
git commit -m "test: validate round 3 task-boundary workflows"
```
