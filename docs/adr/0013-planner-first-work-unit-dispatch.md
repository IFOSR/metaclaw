---
status: accepted
---

# Planner-first work unit dispatch

## Context

MetaClaw's previous active path let `SemanticIntentRouter`, `ExecutionPolicyPlanner`, and `ExecutorRoutingCoordinator` participate in executor selection. That spread business dispatch across multiple layers and made it hard to support long-thread task lifecycle management, durable work graphs, cloud-hosted agent instances, and Feishu-driven control.

The new vocabulary is:

- `Task`: the user-visible long-running conversation window.
- `Subtask`: a durable node in a task's work graph.
- `AgentClass`: a fixed agent configuration template.
- `WorkUnit`: a concrete runtime agent instance.
- `Planner`: the only business dispatch owner inside a task.
- `Executor`: the agent class that performs claimed subtasks.

## Decision

MetaClaw now uses the planner-first path:

`Task -> Planner Work Unit -> Work Graph(Subtasks) -> Executor Work Unit claim Subtask -> SubtaskExecutionSpec -> ExecutionRuntime`

The old route coordinator is not part of the main execution path. Its useful logic is split into planner skills:

- `IntentRecognitionSkill` recognizes direct reply, task control, durable task, clarification, no action, and coarse capability. It does not output an executor.
- `PlannerRoutingSkill` reuses the old strategy heuristics to build `WorkGraphPlan` / `SubtaskPlan` and candidate `AgentClass` names. It does not claim a work unit, write route events, or produce `ExecutionPolicy`.

`ExecutionRuntime` accepts a `SubtaskExecutionSpec`, which already includes the claimed subtask, executor work unit, and agent class. Runtime executes one claim attempt and reports the result; it does not own fallback chains or executor selection.

## First Implementation Choices

- Use a fixed SQLite-backed pool: seed `planner-1` and `executor-1`.
- Persist `agent_classes`, `subtasks`, `task_events`, `work_units`, `work_unit_events`, and `worktree_leases`.
- Migrate existing `executor_profiles` rows into `agent_classes` as `kind=executor`.
- Keep the current single-active-top-level-task admission rule.
- Execute subtasks serially by dependency readiness inside one task.
- Implement claim, release, heartbeat, heartbeat sweep, draining/stopped states, and event recording for work units.
- Add the worktree lease table and repository interface, but do not yet allocate real git worktrees.
- Treat runtime failure as a planner recovery/replanning event. The old fallback strategy is retained only as migration reference, not as the active path.

## Future Optimizations

- Connect worktree leases to real git worktree allocation and release.
- Add parallel subtask scheduling once multiple executor work units and worktree isolation are available.
- Replace the fixed pool with elastic work unit spawning for cloud-hosted executors.
- Add error-type-aware fallback: automatic retry for infrastructure failures, planner rescheduling for task/quality failures, and human review for risky or ambiguous failures.
- Move all user-input intake fully behind planner work units as Feishu task windows become the primary control surface.

## Consequences

The platform layer now arbitrates resources only: idle work units, claims, heartbeat health, and leases. Planner owns business decomposition and dispatch decisions. This removes the old multi-layer executor routing path from session execution and gives future Feishu and cloud execution work a durable lifecycle model to attach to.
