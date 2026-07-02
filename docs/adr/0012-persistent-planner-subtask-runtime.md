---
status: accepted
---

# Persistent planner and subtask runtime

MetaClaw will keep the existing single-active-top-level-task admission rule for the first planner rewrite, and will add persistent subtask state plus work unit runtime state inside that active task. An external Codex-backed planner may propose a work graph, but MetaClaw deterministically validates it, persists subtasks and task events, claims executor work units, allocates worktree leases, and schedules execution.

The planner is temporary and only coordinates; it never performs executor work. Planner recovery must replay durable task/subtask state, task events, and work unit events, not the in-memory `MetaclawSession.output` stream. `session` remains the CLI/TUI/gateway connection and UI projection, not the source of truth.

This is the MetaClaw implementation of the handoff planner-routing design:

- Planner decisions and execution authorization stay separate. The planner may produce subtasks with a required execution capability, including a deliberate `no_action`, but only the runtime claim step selects an executor work unit and starts work.
- The first instance pool is fixed and SQLite-backed. Slow-changing capability/profile information is persisted; fast-changing busy/free/lease state is treated as runtime state and may be refreshed or swept.
- Worktree contention is managed at the work unit layer. If the work unit claimed for a subtask cannot acquire its worktree lease, that subtask waits or blocks while independent subtasks under the same task may still proceed.
- A suspended or blocked subtask releases its executor work unit. Resumption is done from persisted work unit state and handoff/event data, not from executor memory.
- Worktree leases require heartbeat/expiry/sweeper behavior so crashed executor sessions cannot permanently block later subtasks.

Considered alternatives: introducing an issue/comment model as the collaboration thread, and opening multi-task concurrency immediately. Both were rejected for the first implementation because they would rewrite the interaction persistence model and admission/scheduler behavior at the same time as the planner/subtask runtime. The chosen path preserves `TaskAdmissionGate`, maps the handoff's issue/comment source-of-truth requirement to task and work unit events, and treats deferred fallback as a later enhancement while retaining the existing executor fallback chain.

