# Multitask Scheduler And Resume Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a preemptive single-executor scheduler, resume context assembly, always-available TUI input, and a usable task list for Metaclaw V1.

**Architecture:** Keep `TaskEngine`, `MemoryEngine`, and `OrchestrationEngine` focused on domain logic, then introduce `SchedulerEngine` to own runtime sequencing and `ResumeContextBuilder` to build execution bundles. Refactor the TUI so input stays interactive while runtime status and task queues are rendered separately.

**Tech Stack:** TypeScript, Ink, React, better-sqlite3, Vitest

---

### Task 1: Extend Task Metadata For Scheduling

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/task-repo.ts`
- Test: `tests/core/task-engine.test.ts`

**Step 1: Write the failing test**

Add a test asserting persisted tasks round-trip `lastSchedulingReason`, `lastInterruptionReason`, and `interruptionCount`.

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/task-engine.test.ts`  
Expected: FAIL because the new metadata is missing from the type and repository mapping.

**Step 3: Write minimal implementation**

Add the metadata fields to `Task`, extend the tasks table migration, and map the fields in `TaskRepo`.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/task-engine.test.ts`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/types.ts src/storage/migrations.ts src/storage/task-repo.ts tests/core/task-engine.test.ts
git commit -m "feat: persist scheduler metadata on tasks"
```

### Task 2: Add Scheduler Engine With Queueing And Preemption

**Files:**
- Create: `src/core/scheduler.ts`
- Modify: `src/core/orchestration.ts`
- Test: `tests/core/scheduler.test.ts`

**Step 1: Write the failing test**

Add tests for:
- choosing the highest-priority `ready` task when idle
- parking the current task when a higher-priority task arrives
- skipping `blocked` tasks

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/scheduler.test.ts`  
Expected: FAIL because `SchedulerEngine` does not exist.

**Step 3: Write minimal implementation**

Implement `SchedulerEngine` with:

```ts
scheduleNext(): Promise<void>
submit(...): Promise<void>
preemptWith(...): Promise<void>
getRuntimeState(): RuntimeState
```

Use `OrchestrationEngine` scores plus a `PREEMPT_DELTA` threshold.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/scheduler.test.ts`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/scheduler.ts src/core/orchestration.ts tests/core/scheduler.test.ts
git commit -m "feat: add single-executor scheduler with preemption"
```

### Task 3: Build Resume Context Assembly

**Files:**
- Create: `src/core/resume-context-builder.ts`
- Modify: `src/executor/prompt-builder.ts`
- Modify: `src/core/context-recaller.ts`
- Test: `tests/core/resume-context-builder.test.ts`

**Step 1: Write the failing test**

Add tests for:
- `resume-parked` bundle includes last progress and interruption reason
- `resume-blocked` bundle includes blocked reason and newly provided material
- memory precedence follows `current input > task-local > contact/project > global`

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/resume-context-builder.test.ts`  
Expected: FAIL because the builder and bundle format do not exist.

**Step 3: Write minimal implementation**

Implement:

```ts
build({
  taskId,
  mode,
  userInput,
  sessionId,
  schedulingReason
}): Promise<ExecutionContextBundle>
```

Update prompt building to render the bundle in fixed order.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/resume-context-builder.test.ts`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/resume-context-builder.ts src/executor/prompt-builder.ts src/core/context-recaller.ts tests/core/resume-context-builder.test.ts
git commit -m "feat: add resume context bundle assembly"
```

### Task 4: Refactor TUI For Always-On Input And Runtime Summary

**Files:**
- Modify: `src/tui/app.tsx`
- Modify: `src/commands/task-commands.ts`
- Test: `tests/tui/execution-indicator.test.ts`
- Test: `tests/tui/task-list.test.ts`
- Test: `tests/tui/input-availability.test.ts`

**Step 1: Write the failing test**

Add tests asserting:
- input remains usable while one task is running
- runtime summary shows running/ready/blocked counts
- `/tasks` groups tasks into running/ready/parked/blocked/done

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/tui/input-availability.test.ts tests/tui/task-list.test.ts`  
Expected: FAIL because the TUI still ties input availability to global execution state and `/tasks` is flat.

**Step 3: Write minimal implementation**

Refactor `App` so submit routes through `SchedulerEngine`, keep the prompt editable, and render a separate runtime summary. Extend `/tasks` with `ready` and `parked` filters plus grouped default output.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/tui/input-availability.test.ts tests/tui/task-list.test.ts tests/tui/execution-indicator.test.ts`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/tui/app.tsx src/commands/task-commands.ts tests/tui/input-availability.test.ts tests/tui/task-list.test.ts tests/tui/execution-indicator.test.ts
git commit -m "feat: refactor tui for multitask runtime visibility"
```

### Task 5: Wire Scheduler Into Entry Flow And Executor Runtime

**Files:**
- Modify: `src/index.ts`
- Modify: `src/executor/codex-cli.ts`
- Modify: `src/executor/claude-code.ts`
- Modify: `src/executor/factory.ts`
- Test: `tests/executor/codex-cli.test.ts`
- Test: `tests/executor/claude-code.test.ts`

**Step 1: Write the failing test**

Add tests for:
- scheduler can call `abort()` on the running executor
- codex and claude adapters resolve a safe interrupted result after abort

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/executor/codex-cli.test.ts tests/executor/claude-code.test.ts`  
Expected: FAIL because interrupted execution is not distinguished from generic failure.

**Step 3: Write minimal implementation**

Wire `SchedulerEngine` and `ResumeContextBuilder` into startup. Make adapter abort behavior compatible with scheduler-driven parking.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/executor/codex-cli.test.ts tests/executor/claude-code.test.ts`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/index.ts src/executor/codex-cli.ts src/executor/claude-code.ts src/executor/factory.ts tests/executor/codex-cli.test.ts tests/executor/claude-code.test.ts
git commit -m "feat: wire scheduler into executor runtime"
```

### Task 6: Regression, Docs, And Real User-Flow Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/metaclaw-os_prd_v2.md`
- Modify: `docs/metaclaw-os_tech_design_v1.md`
- Modify: `docs/metaclaw-os_tui_spec_v1.md`
- Modify: `docs/metaclaw-os_implementation_v1.md`

**Step 1: Run the targeted test suites**

Run:

```bash
npm test -- tests/core/scheduler.test.ts tests/core/resume-context-builder.test.ts tests/tui/input-availability.test.ts tests/tui/task-list.test.ts
```

Expected: PASS

**Step 2: Run full regression**

Run:

```bash
npm run lint
npm test
npm run build
```

Expected: All green

**Step 3: Run real end-to-end checks**

Verify these flows in the real TUI:
- create a task while another task is running
- high-priority task preempts current running task
- blocked task automatically yields execution
- resume task restores progress and memory context
- `/tasks` shows grouped task visibility

**Step 4: Update docs and README**

Document the scheduler model, resume bundle, grouped task list, and default codex executor.

**Step 5: Commit**

```bash
git add README.md docs/metaclaw-os_prd_v2.md docs/metaclaw-os_tech_design_v1.md docs/metaclaw-os_tui_spec_v1.md docs/metaclaw-os_implementation_v1.md
git commit -m "docs: document multitask scheduler and resume model"
```
