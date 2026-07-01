---
status: accepted
---

# Persistent work-unit leader runtime

MetaClaw will keep the existing single-active-top-level-task admission rule for the first leader rewrite, and will add a persistent work-unit runtime inside that active task. An external Codex-backed leader planner may propose a work graph, but MetaClaw deterministically validates it, persists work units and work-unit events, claims executor instances, allocates worktree leases, and schedules execution.

The leader is temporary and only coordinates; it never performs executor work. Leader recovery must replay durable task/work-unit state and `work_unit_events`, not the in-memory `MetaclawSession.output` stream. `session` remains the CLI/TUI/gateway connection and UI projection, not the source of truth.

This is the MetaClaw implementation of the handoff leader-routing design:

- Leader planning and execution authorization stay separate. The leader may produce work units with a `CapabilityClass`, including a deliberate `no_action`, but only the runtime claim step selects an executor instance and starts work.
- The first instance pool is fixed and SQLite-backed. Slow-changing capability/profile information is persisted; fast-changing busy/free/lease state is treated as runtime state and may be refreshed or swept.
- Worktree contention is managed at the work-unit layer. If a work unit cannot acquire its worktree lease, that work unit waits or blocks while independent work units under the same top-level task may still proceed.
- A suspended or blocked work unit releases its executor instance. Resumption is done from persisted work-unit state and handoff/event data, not from executor memory.
- Worktree leases require heartbeat/expiry/sweeper behavior so crashed executor sessions cannot permanently block later work units.

Considered alternatives: introducing an issue/comment model as the collaboration thread, and opening multi-top-level-task concurrency immediately. Both were rejected for the first implementation because they would rewrite the interaction persistence model and admission/scheduler behavior at the same time as the work-unit runtime. The chosen path preserves `TaskAdmissionGate`, maps the handoff's issue/comment source-of-truth requirement to `work_unit_events`, uses `CapabilityClass` as the member category language, and treats deferred fallback as a later enhancement while retaining the existing executor fallback chain.
