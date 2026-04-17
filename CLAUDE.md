# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Metaclaw OS is a task continuity, preference memory, and proactive orchestration hub for knowledge workers. It's a TUI application (similar to Claude Code's CLI interface) that manages long-running, interruptible tasks across sessions.

**Core value proposition:** Not another AI agent — it's the "brain" that remembers where you left off, knows your preferences, and tells you what to do next. Executors (like Claude Code) are replaceable workers; Metaclaw is the irreplaceable coordinator.

**Language:** The project docs and target users are Chinese-speaking. All user-facing text, comments, and documentation should be in Chinese unless otherwise specified.

## Three Core Pillars (V1)

1. **Continuity** — Tasks survive interruptions, cross-day pauses, and context switches via structured snapshots
2. **Memory** — Preference extraction with a "three-occurrence confirmation" rule; scoped (Global > Project > Contact > Task-local > One-off)
3. **Guidance** — Proactive task dashboard with explainable priority recommendations

## Architecture (from tech design)

Five modules:

- **Task Engine** — Task CRUD, state machine transitions, snapshot generation, resume summaries
- **Memory Engine** — Preference observation → candidate → confirmed lifecycle, scoped recall with keyword matching
- **Orchestration Engine** — Dashboard generation, priority sorting (urgency, readiness, continuity benefit, downstream impact, staleness cost), reminder throttling
- **Executor Adapter** — V1 uses Claude Code only; injects task context + recalled preferences, captures results/errors
- **Storage Layer** — Local SQLite (`~/.metaclaw/metaclaw.db`), snapshot files, YAML config

## Task State Machine

```
CREATED → READY → RUNNING → DONE → ARCHIVED
                    ↓   ↓
                  PARKED  BLOCKED → READY (manual unblock)
                    ↓
                  READY
PARKED/CREATED → CANCELLED
```

Snapshots are generated on RUNNING→PARKED transitions.

## Preference Scope Precedence

```
one-off (current request) > task-local > contact/project > global
```

Contact vs Project conflict: prefer Contact for communication tasks, Project for deliverable specs. If ambiguous, prompt user.

## Storage Layout

```
~/.metaclaw/
├── config.yaml
├── executors.yaml
├── metaclaw.db          # SQLite — tasks, preferences, observations, interactions
└── snapshots/
    └── task_xxx/
        └── snapshot_v1.json
```

## Key Design Decisions

- V1 is local-only, single-machine, no cloud sync
- No background daemon — proactive guidance is session-scoped (startup dashboard + in-conversation reminders)
- Blocked task wakeup is manual only in V1 (file watchers and time triggers are V2)
- Preference recall is keyword + exact match only (no embeddings until V1.5)
- All executor results must flow back through Metaclaw's aggregation layer — never expose raw executor output
- High-risk actions (external messages, legal/financial submissions) require explicit user confirmation

## Slash Commands (TUI)

- `/dashboard` — Task priority board
- `/tasks [active|blocked|done]` — List tasks
- `/task <id> [pause|resume|block|unblock|cancel|done]` — Task operations
- `/memory [search|add|edit|delete|candidates|confirm|reject|stats]` — Preference management
- `/attach <path>` — Associate files with current task

## Reference Docs

- `docs/metaclaw-os_prd_v2.md` — Product requirements (scenarios, acceptance criteria, metrics)
- `docs/metaclaw-os_tech_design_v1.md` — Technical design (data models, SQLite schema, executor integration)
- `docs/metaclaw-os_tui_spec_v1.md` — TUI interaction spec (commands, dashboard layout, dialog flows)
