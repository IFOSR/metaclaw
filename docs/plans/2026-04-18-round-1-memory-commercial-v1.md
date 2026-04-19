# Round 1 Memory Commercial V1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the Round 1 commercial V1 memory gaps by making scoped preferences actually usable, adding deterministic precedence, and surfacing memory injection transparently in the TUI and task views.

**Architecture:** Keep the current `MemoryEngine`, `ResumeContextBuilder`, and session dispatch flow as the backbone. Extend them incrementally with scope-aware CRUD, a lightweight precedence resolver, and user-visible audit output instead of replacing the current memory model.

**Tech Stack:** TypeScript, Ink, React, better-sqlite3, Vitest

---

## Round Goal

This round must make the PRD memory promise user-visible without rebuilding the system:

- `Global / Project / Contact / Task-local` preferences must be manageable from the product surface
- execution must apply preferences in a deterministic order
- the user must be able to see what was injected, from which scope, and why
- task resume must continue to favor task-local memory over broad/global memory

## Acceptance Pack

Before implementation, use the Round 1 acceptance pack in:

- `examples/e2e/round-1-memory/README.md`
- `examples/e2e/round-1-memory/scripts/00-memory-command-smoke.txt`
- `examples/e2e/round-1-memory/manual/01-three-hit-confirm-and-recall.md`
- `examples/e2e/round-1-memory/manual/02-scope-and-precedence.md`
- `examples/e2e/round-1-memory/manual/03-task-local-resume-memory.md`

These scenarios are the release-grade acceptance criteria for this round.

---

### Task 1: Add Commercial Memory Acceptance Coverage First

**Files:**
- Create: `examples/e2e/README.md`
- Create: `examples/e2e/round-1-memory/README.md`
- Create: `examples/e2e/round-1-memory/scripts/00-memory-command-smoke.txt`
- Create: `examples/e2e/round-1-memory/manual/01-three-hit-confirm-and-recall.md`
- Create: `examples/e2e/round-1-memory/manual/02-scope-and-precedence.md`
- Create: `examples/e2e/round-1-memory/manual/03-task-local-resume-memory.md`

**Step 1: Write the acceptance pack**

Document the real user scenarios before touching implementation:

- repeated instruction -> candidate -> confirm -> recall
- scoped preference creation and inspection
- precedence between task-local, contact/project, and global
- resume flow favoring task-local memory
- TUI visibility requirements for memory injection

**Step 2: Verify scenarios are runnable from current repo structure**

Run:

```bash
find examples/e2e/round-1-memory -maxdepth 3 -type f | sort
```

Expected: all Round 1 acceptance files exist.

**Step 3: Commit**

```bash
git add examples/e2e docs/plans/2026-04-18-round-1-memory-commercial-v1.md
git commit -m "docs: add round 1 memory acceptance pack"
```

### Task 2: Make Scoped Memory CRUD Usable

**Files:**
- Modify: `src/commands/memory-commands.ts`
- Modify: `src/core/memory-engine.ts`
- Modify: `src/storage/preference-repo.ts`
- Test: `tests/commands/memory-commands.test.ts`
- Test: `tests/core/memory-engine.test.ts`

**Step 1: Write the failing tests**

Add tests for:

- adding a `project` preference with subject
- adding a `contact` preference with subject
- adding a `task-local` preference tied to a task
- listing and searching preferences without losing scope/subject
- editing scope/subject/content for an existing preference

**Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/commands/memory-commands.test.ts tests/core/memory-engine.test.ts
```

Expected: FAIL because current commands mostly default to `global` and do not expose scoped memory as a first-class product capability.

**Step 3: Write minimal implementation**

Extend `/memory` so commercial V1 can manage scoped preferences with a stable syntax such as:

```text
/memory add --scope global --type style 输出用 Markdown 格式
/memory add --scope project --subject Phoenix --type domain 项目代号统一叫 Phoenix
/memory add --scope contact --subject 张总 --type contact 给张总的邮件用正式语气
/memory add --scope task-local --subject <task_id> --type style 当前任务输出保留表格结构
```

The implementation should stay compatible with the current simple command router by parsing flags inside `memory-commands.ts` instead of introducing a new CLI parser layer.

**Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/commands/memory-commands.test.ts tests/core/memory-engine.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/memory-commands.ts src/core/memory-engine.ts src/storage/preference-repo.ts tests/commands/memory-commands.test.ts tests/core/memory-engine.test.ts
git commit -m "feat: support scoped memory management commands"
```

### Task 3: Add Deterministic Memory Precedence

**Files:**
- Modify: `src/core/memory-engine.ts`
- Modify: `src/core/resume-context-builder.ts`
- Modify: `src/core/types.ts`
- Test: `tests/core/memory-engine.test.ts`
- Test: `tests/core/resume-context-builder.test.ts`

**Step 1: Write the failing tests**

Add tests for:

- `task-local` outranking `contact`, `project`, and `global`
- `contact` outranking `project` when user intent is clearly contact-oriented
- `project` outranking `global` for project terminology/style
- explicit current input remaining visible as the top-priority instruction

**Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/core/memory-engine.test.ts tests/core/resume-context-builder.test.ts
```

Expected: FAIL because current recall mostly sorts by scope priority and does not apply commercial V1 precedence rules explicitly.

**Step 3: Write minimal implementation**

Add a lightweight precedence resolver:

- keep current keyword recall as the candidate source
- annotate each candidate with a precedence reason
- resolve conflicts with rules that match the PRD:
  - explicit user instruction
  - task-local
  - contact/project
  - global
- keep V1 simple by using rule-based heuristics, not model inference

**Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/core/memory-engine.test.ts tests/core/resume-context-builder.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/core/memory-engine.ts src/core/resume-context-builder.ts src/core/types.ts tests/core/memory-engine.test.ts tests/core/resume-context-builder.test.ts
git commit -m "feat: add deterministic memory precedence rules"
```

### Task 4: Surface Memory Injection Transparently In The Session And TUI

**Files:**
- Modify: `src/session/metaclaw-session.ts`
- Modify: `src/commands/task-commands.ts`
- Modify: `src/tui/app.tsx`
- Test: `tests/tui/execution-progress.test.ts`
- Test: `tests/tui/task-list.test.ts`
- Create: `tests/tui/memory-injection-visibility.test.ts`

**Step 1: Write the failing tests**

Add tests asserting:

- execution output shows injected preference scope, confidence, and hit reason
- task detail shows the latest injected preferences and executor used
- TUI renders memory injection details in a stable block instead of burying them in noisy transcript lines

**Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/tui/execution-progress.test.ts tests/tui/task-list.test.ts tests/tui/memory-injection-visibility.test.ts
```

Expected: FAIL because the current runtime output only shows scope and content, and `/task <id>` does not expose a usable memory audit surface.

**Step 3: Write minimal implementation**

Surface a compact, commercial-grade memory audit block:

- before execution:
  - preference scope
  - content
  - confidence
  - hit reason
- in `/task <id>`:
  - latest injected preference IDs and readable summaries
  - latest executor
  - latest scheduling/interruption reason

Keep the UI textual, but structured and stable.

**Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/tui/execution-progress.test.ts tests/tui/task-list.test.ts tests/tui/memory-injection-visibility.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/session/metaclaw-session.ts src/commands/task-commands.ts src/tui/app.tsx tests/tui/execution-progress.test.ts tests/tui/task-list.test.ts tests/tui/memory-injection-visibility.test.ts
git commit -m "feat: expose memory injection details in tui and task views"
```

### Task 5: Validate Round 1 With Scripted And Manual E2E

**Files:**
- Modify: `README.md`
- Modify: `examples/e2e/round-1-memory/README.md`

**Step 1: Run targeted regression**

Run:

```bash
npm test -- tests/core/memory-engine.test.ts tests/core/resume-context-builder.test.ts tests/commands/memory-commands.test.ts tests/tui/memory-injection-visibility.test.ts
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
node dist/index.js --script examples/e2e/round-1-memory/scripts/00-memory-command-smoke.txt
```

Expected: PASS-like transcript showing scoped memory commands and visible memory state transitions.

**Step 4: Run manual acceptance**

Execute:

- `examples/e2e/round-1-memory/manual/01-three-hit-confirm-and-recall.md`
- `examples/e2e/round-1-memory/manual/02-scope-and-precedence.md`
- `examples/e2e/round-1-memory/manual/03-task-local-resume-memory.md`

Expected: all Round 1 memory acceptance expectations are satisfied in the real TUI.

**Step 5: Commit**

```bash
git add README.md examples/e2e/round-1-memory/README.md
git commit -m "docs: document round 1 memory verification flow"
```

---

## Round 1 Exit Criteria

Round 1 is complete only if all of the following are true:

- the user can manage `global / project / contact / task-local` memory from product commands
- memory precedence behaves deterministically and matches the PRD rules
- execution visibly explains which preferences were injected and why
- task resume still favors task-local memory
- all Round 1 tests pass
- the scripted and manual Round 1 acceptance scenarios are ready for final user validation
