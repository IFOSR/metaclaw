# MetaClaw Roadmap Remaining TODOs

Date: 2026-06-24

Baseline document: `docs/plans/2026-06-21-metaclaw-architecture-convergence-roadmap.md`

This document tracks only gaps against the roadmap above. It intentionally ignores older review documents.

## Goal

Converge the current implementation to the roadmap target path:

```text
InputController
  -> IntentOrchestrator
  -> TaskRuntimeService
  -> MemoryContextService
  -> ExecutionPlanningService
  -> ExecutionRuntime
  -> VerificationAndDeliveryService
```

## Remaining TODOs

### 1. IntentDecisionV2 must not be rewritten in MetaclawSession

Roadmap requirement: intent timeout must return a conservative decision, either conversation or clarification. Keyword fallback must not create a durable task.

Current gap: `MetaclawSession` rewrites a clarification timeout decision into a durable task when another task is running.

Target:

- `IntentOrchestrator.decide()` is the only place that creates the final `IntentDecisionV2`.
- `MetaclawSession` consumes the decision without mutating it.
- Busy timeout remains clarification and does not enqueue work.

Tests:

- Architecture test forbids `shouldBusyFallbackIntentToDurableTask`.
- Session routing test verifies busy timeout does not create a task.

### 2. Rule hints must not directly decide natural-language task control

Roadmap requirement: regex and rule hints may only be hints or safety guards. They must not directly decide durable task, executor, multi-executor, or resume task behavior.

Current gap: `IntentOrchestrator.decide()` resolves task-control hints before the semantic router and can return `task_control` without semantic arbitration.

Target:

- Rule hints are preserved as evidence.
- Semantic decisions remain the final source of task control.
- Safety guards can still force conservative clarification.

Tests:

- Intent orchestrator test verifies task-control hints do not bypass semantic routing.
- Intent orchestrator test verifies semantic `taskControl` is still normalized correctly.

### 3. TaskRuntimeService must not format UI or abort executor

Roadmap requirement: `TaskRuntimeService` owns task lifecycle and scheduling eligibility. It must not format UI text and must not directly consume executor execution.

Current gap: `TaskRuntimeService.clearTasks()` returns formatted output and calls `executor.abort()` for running tasks. `formatTaskStatus()` also lives inside `TaskRuntimeService`.

Target:

- `TaskRuntimeService.clearTasks()` returns structured task state only.
- UI formatting moves to `SessionPresentationService`.
- Runtime abort is triggered by scheduler/session boundary, not task service.

Tests:

- Task runtime tests verify clear/preempt do not call executor abort.
- Architecture test forbids `formatTaskStatus`, `formatTaskClearResult`, and `deps.executor.abort()` in task runtime service.

### 4. Recall review policy must leave MetaclawSession

Roadmap requirement: memory recall and execution context construction must leave `executeTask()` and session orchestration.

Current gap: `prepareTaskExecution()` still resolves recall review policy, accepted selections, audit events, and display blocks.

Target:

- Introduce a recall review/application service.
- `MetaclawSession.prepareTaskExecution()` delegates recall review and only appends returned output lines.

Tests:

- Service unit tests cover accepted and suppressed recall decisions.
- Architecture test ensures session no longer directly creates recall policy service or writes suppressed recall audit loops.

### 5. executeTask must shrink to runtime/delivery glue

Roadmap requirement: `executeTask()` should degrade to `ExecutionRuntime.run(plan, context)` and delivery handling.

Current gap: `executeTask()` still coordinates memory context, routing, runtime metadata display, verification, task update, memory capture, and scheduler state.

Target:

- Introduce an execution coordinator/facade for the execution main path.
- `MetaclawSession` delegates execution and keeps only snapshot/output facade responsibilities.

Tests:

- Architecture test reduces allowed execution-path calls in session.
- End-to-end session tests keep task creation, execution, verification, and delivery behavior stable.

### 6. ExecutionRuntime must return the standard ExecutionResult contract

Roadmap requirement: `ExecutionRuntime.run()` should produce a standardized `ExecutionResult`, not expose raw executor/race/fallback internals to session.

Current gap: `ExecutionRuntime.run()` returns `ExecutionRuntimeRunResult` with raw executor, raw result, race executors, fallback lines, and nested `execution`.

Target:

- `ExecutionRuntime.run()` returns `ExecutionResult`.
- Runtime diagnostics needed for display are part of the standardized result contract.
- Session consumes only `ExecutionResult`.

Tests:

- Execution runtime tests assert the direct return is `ExecutionResult`.
- Architecture test forbids session from reading `runtimeResult.result`, `runtimeResult.executor`, `runtimeResult.fallbackLines`, or nested `runtimeResult.execution`.

### 7. Executor registry should be adapter-factory registration driven

Roadmap requirement: built-in executors also use `profile + adapterFactory` registration. Adding an executor should not require editing multiple hard-coded switches.

Current gap: built-in adapter factories and command mapping remain hard-coded in `execution-runtime.ts`.

Target:

- Expose a single adapter factory registry.
- Resolve default executor commands through that registry.
- Keep `CustomCliExecutorAdapter` as runtime-command adapter for custom profiles.

Tests:

- Boundary tests assert no legacy factory dependency.
- Registry tests assert built-ins and custom profiles resolve through the registry path.

### 8. Verification pipeline must not rely only on regex smoke checks

Roadmap requirement: regex verifier is only a smoke check. Test evidence, artifact, aggregation, and optional LLM verification should be part of the delivery pipeline.

Current gap: verifier types exist, but the session uses the synchronous delivery path and cannot run async verifiers.

Target:

- Session uses async delivery preparation.
- Async verifier pipeline remains injectable.
- Default pipeline keeps deterministic artifact/test/aggregation checks.

Tests:

- Verification service tests cover async verifier blocking.
- Session execution test verifies async delivery preparation is awaited.

### 9. MetaclawSession must continue shrinking toward facade / compat glue

Roadmap requirement: `MetaclawSession` keeps dependency assembly, state snapshot, and event/output facade only.

Current gap: session is smaller than before but still owns task-control branches, task creation glue, recall review, and execution coordination.

Target:

- After items 1-8, re-review remaining session methods.
- Add architecture tests for newly moved responsibilities.

Tests:

- Full session suite.
- Full TUI suite.
- Full project test suite.

## Completion Review

Status: implementation complete, pending final full-suite verification before GitHub sync.

### 1. IntentDecisionV2 must not be rewritten in MetaclawSession

Complete.

- Removed the busy fallback rewrite path from `MetaclawSession`.
- Busy intent timeout now remains conservative clarification.
- Covered by `tests/tui/input-availability.test.ts` and `tests/session/metaclaw-session-architecture-boundary.test.ts`.

### 2. Rule hints must not directly decide natural-language task control

Complete.

- `IntentOrchestrator` now always calls the semantic router for natural-language arbitration.
- Parser/task-control hints and conversation focus hints are consumed inside `SemanticIntentRouter`, then normalized through `IntentOrchestrator`.
- Removed the focus-hint direct return path from `IntentOrchestrator`.
- Covered by `tests/core/intent-orchestrator.test.ts`, `tests/core/semantic-intent-router.test.ts`, `tests/core/intent-golden.test.ts`, and session/TUI routing tests.

### 3. TaskRuntimeService must not format UI or abort executor

Complete.

- `TaskRuntimeService.clearTasks()` returns structured task state.
- Task status and clear result formatting live in `SessionPresentationService`.
- Executor abort remains at the outer session/scheduler boundary when clearing a running task.
- Covered by `tests/core/task-runtime-service.test.ts`, `tests/core/task-runtime-boundary.test.ts`, and `tests/session/metaclaw-session-architecture-boundary.test.ts`.

### 4. Recall review policy must leave MetaclawSession

Complete.

- Added `RecallReviewApplicationService`.
- `MetaclawSession.prepareTaskExecution()` delegates recall review policy, audit, accepted selections, and recall display lines to the service.
- Covered by `tests/core/recall-review-application-service.test.ts` and session architecture boundary tests.

### 5. executeTask must shrink to runtime/delivery glue

Complete.

- Added `SessionExecutionCoordinator`.
- `MetaclawSession.executeTask()` now only validates the task, appends execution guidance, pops approved recall selection, and delegates execution.
- Memory context, executor routing, runtime execution, verification, delivery, memory capture, and scheduler completion handling moved to the coordinator.
- Covered by `tests/session/metaclaw-session-architecture-boundary.test.ts`, `tests/core/memory-context-boundary.test.ts`, `tests/core/verification-and-delivery-boundary.test.ts`, and session/TUI end-to-end tests.

### 6. ExecutionRuntime must return the standard ExecutionResult contract

Complete.

- `ExecutionRuntime.run()` returns `ExecutionResult` directly.
- Race, abort, and fallback diagnostics live under `ExecutionResult.runtime`.
- Session/coordinator no longer consumes `runtimeResult.*` or nested execution results.
- Covered by `tests/core/execution-runtime.test.ts` and `tests/core/execution-runtime-boundary.test.ts`.

### 7. Executor registry should be adapter-factory registration driven

Complete.

- Added `ExecutorAdapterRegistry` and `createDefaultExecutorAdapterRegistry()`.
- Built-in executor adapter creation is registry-driven.
- `createDefaultExecutor()` resolves through command aliases registered in the adapter registry.
- Custom profiles still use `CustomCliExecutorAdapter` through runtime-command profile data.
- Covered by `tests/core/execution-runtime.test.ts`, `tests/core/execution-runtime-boundary.test.ts`, and executor factory boundary tests.

### 8. Verification pipeline must not rely only on regex smoke checks

Complete.

- Session execution path now awaits `VerificationAndDeliveryService.prepareAsync()`.
- Async verifier injection remains supported.
- Default delivery path retains deterministic artifact collection, aggregation, and verifier checks.
- Covered by `tests/core/verification-and-delivery-service.test.ts`, `tests/core/verification-and-delivery-boundary.test.ts`, and task result aggregation tests.

### 9. MetaclawSession must continue shrinking toward facade / compat glue

Complete for this roadmap pass.

- `MetaclawSession` remains the composition/state/output facade, while execution runtime coordination has moved to `SessionExecutionCoordinator`.
- Architecture tests now enforce that memory context preparation, execution runtime calls, verification delivery preparation, scheduler dispatch completion, and recall review application stay outside the session facade.
- Remaining session responsibilities are dependency assembly, command/input coordination, compatibility glue, snapshots, and user-facing output plumbing.

## Verification Plan

Final sync is allowed only after these pass:

- `npm run lint`
- `npx vitest run tests/core tests/session tests/tui`
- `npm test`
