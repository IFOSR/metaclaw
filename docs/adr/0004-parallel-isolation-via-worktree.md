---
status: proposed
---

# Parallel executor isolation via git worktree

## Context

The user requires that executors may run multiple MetaClaw tasks in parallel, but **two executor sessions must never work in the same working directory at the same time** — they would interfere with each other's file changes. The earlier-drafted `ExecutionPolicy.isolationRequired` field was a boolean with unclear semantics. Research into how Claude Code-class agents handle this (Claude Code has no built-in multi-session coordination for one workspace; the community pattern is to avoid same-dir parallelism, not coordinate it) shows the real mechanism is workspace isolation, plus orchestration for cross-task dependencies.

The user also surfaced that future decomposition may produce **dependent parallel work**: e.g. executors A and B start together, but B's later steps wait for A's result. Worktree isolation handles the file-interference half; the orchestration layer (this routing rewrite's sibling) handles the dependency half.

## Decision

`isolationRequired` on `ExecutionPolicy` means: **allocate this task a dedicated, exclusive git worktree**. Two rules follow:

1. **Parallel tasks → separate worktrees.** Each task with `isolationRequired=true` gets its own worktree (independent directory + branch, shared `.git` object store). Two such tasks never share a directory, so they cannot dirty-write each other.
2. **Same worktree → serial.** Within one worktree, at most one executor session runs at a time. A second task targeting an occupied worktree waits (queued) rather than opening a second session in it.

Cross-task result coordination (B waits for A) is **not** a worktree concern — it belongs to the decomposition/DAG orchestration layer, which is explicitly deferred (see the open "decomposition-DAG" question). The worktree mechanism only guarantees isolation; it does not sequence dependent steps.

## Considered Options

- **File locking / write-conflict detection.** Rejected: detects interference after the fact but does not prevent it. Two agents editing the same file still corrupt it. The user's requirement is prevention, not detection.
- **Sandbox per task.** Rejected as the isolation primitive: a sandbox isolates execution environment (permissions, network) but is not oriented around a shared git repo's working tree. Worktree is the right tool for "same repo, parallel branches, no file clash." (Sandboxing may still apply for unrelated security reasons — orthogonal.)
- **No isolation, rely on convention.** Rejected: the user explicitly forbids same-workspace parallel sessions; convention is not a guarantee.

## Consequences

- `isolationRequired` is no longer a vague boolean — it is a directive to provision a worktree. The routing/policy layer must hand the executor a worktree path, and track worktree occupancy to enforce same-worktree serial access.
- Worktree lifecycle (creation, cleanup, branch naming) becomes a new responsibility — likely a small service the orchestration layer owns. Not specified here.
- Dependent-parallel workflows (A+B then B-after-A) are **not solved by this ADR**. They need the deferred decomposition-DAG design. Until then, such workflows are handled as sequential subtasks across turns.
- **Verification (completed 2026-06-25):** Claude Code ships a native `--worktree` / `-w` flag placing checkouts under `.claude/worktrees/<name>/`, with `git worktree lock` to prevent concurrent cleanup (stale-lock auto-cleanup fixed in v2.1.187). For non-git repos, `WorktreeCreate` / `WorktreeRemove` hooks support SVN/Perforce/Mercurial. This confirms the worktree mechanism is the industry primary isolation tool, not just a git idiom — strengthening the decision.
- **Scope correction from research:** parallel execution has **three** distinct patterns, not one. Isolation (worktrees, each session separate) is only the first. The others — *coordination* (Claude Code Agent Teams: team lead + teammates with shared file-locked task list and mailbox) and *partitioning* (Writer/Reviewer operating on different file sets) — are not addressed by `isolationRequired` alone. The decomposition-DAG design (deferred) must choose which pattern applies per workflow; this ADR covers only the isolation pattern.
- **Hardened failure-mode note (GitHub issue #69994):** under high concurrency + long sessions, Claude Code's Write tool reports success without the file actually persisting, and Bash/Read output can be replayed or forged. Implication for MetaClaw: an executor claiming "write succeeded" is not proof of persistence. The capability-registration flow (ADR-pending) and any verification step must allow **out-of-band verification** — checking the result from an independent process, not trusting the executor's self-report. This is a technical justification for the "user may manually verify before confirming" step already agreed.
- **Decision on the `multi_executor` mode (2026-06-25):** `multi_executor` means *only* the isolation pattern — multiple executors each in a dedicated worktree, doing causally independent work, no dependency, no coordination. The partition pattern (Writer/Reviewer on one worktree) is excluded because same-worktree serial access (rule 2) forbids it; quality review is handled instead by the serial `reviewerExecutor` field, not by parallel partitioning. The coordination pattern (Agent Teams) is excluded because it depends on the deferred decomposition-DAG. This narrows `multi_executor` to the one parallel pattern the router can currently define soundly.
