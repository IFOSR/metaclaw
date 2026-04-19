# Metaclaw TUI Refresh Design

**Date:** 2026-04-19  
**Status:** approved  
**Direction:** conservative Codex-like refresh

**Related files:**
- `src/tui/app.tsx`
- `tests/tui/static-output.test.ts`
- `tests/tui/execution-progress.test.ts`
- `tests/tui/guidance-panel.test.ts`
- `tests/tui/guidance-blocks.test.ts`
- `tests/tui/execution-indicator.test.ts`
- `docs/metaclaw-os_tui_spec_v1.md`

---

## 1. Goal

Upgrade the current terminal UI to a commercial-grade V1 experience without rewriting the Ink app architecture.

This round does not change task scheduling or executor semantics. It changes how state is presented so users can immediately understand:

- what they typed
- what the system is doing
- whether the executor is actually progressing
- where the final answer starts and ends

---

## 2. Design Principles

- Keep the TUI single-column and terminal-native.
- Separate speaker identity from execution phase.
- Preserve current information density, but improve hierarchy.
- Do not expose verbose hidden chain-of-thought.
- Avoid fragile multi-column layouts in narrow terminals.
- Keep the composer usable while tasks are running whenever the runtime allows it.

---

## 3. Information Architecture

The transcript will be rendered as semantic blocks instead of flat lines. Each block belongs to one of these categories:

### 3.1 User

Purpose: show user input with the highest clarity.

Rules:
- prefix remains `>`
- high-contrast color
- no extra decoration
- always starts a new block

### 3.2 System

Purpose: show orchestration and routing behavior.

Examples:
- task association
- queueing
- resume decisions
- confirmation prompts
- permission notices

Rules:
- prefix `→`
- lower visual weight than user and result blocks

### 3.3 Context

Purpose: show pre-execution preparation.

Examples:
- recalling task context
- material injection
- context bundle ready

Rules:
- one-level indentation under system phase
- bullet prefix such as `·`
- lighter color than system lines

### 3.4 Agent

Purpose: show executor progress clearly enough that the user knows the task is moving.

Examples:
- executor started
- current stage
- streamed execution steps
- waiting for executor response

Rules:
- phase line and step lines have different indentation
- keep concise and operational
- do not print speculative reasoning dumps

### 3.5 Result

Purpose: separate the final answer from process logs.

Rules:
- explicit success or failure header
- duration shown in the header when available
- result body starts on a fresh block
- generated file paths and artifacts appear in a stable tail section

### 3.6 Status

Purpose: preserve a compact runtime summary without turning it into a second UI.

Rules:
- fixed numeric counts only
- one line for counts
- one line for the latest event
- never mix `无`, `N`, and numeric formats

---

## 4. Visual Grammar

### 4.1 Prefix grammar

- `>` user input
- `→` system routing and notices
- `·` context or executor progress items
- `✓` successful completion
- `!` warning, failure, or confirmation-needed states

### 4.2 Indentation grammar

- level 0: user and final result headers
- level 1: system events
- level 2: context details and executor step details

This creates a clear reading rhythm:
- user asks
- system routes
- context loads
- agent executes
- result lands

### 4.3 Color grammar

- user: bright/high-contrast
- system: blue-gray or cyan-gray
- context: muted secondary
- agent active: cyan/green emphasis
- result success: green
- warning/confirm/failure: yellow or red
- status line: neutral with highlighted numbers

Colors support scanning, but content must still be readable on plain terminals with limited color support.

---

## 5. Running Feedback

The current UI can say a task is `running` without showing enough evidence. This refresh adds visible progress semantics.

### 5.1 Required running signals

While an executor is active, the transcript must show at least one of:

- current phase
- most recent step
- waiting-for-executor notice if there has been no fresh step for a short interval

### 5.2 Waiting state

If the executor is still active but no new visible output has appeared recently, render a light progress line such as:

`· 正在等待执行器返回...`

This prevents the UI from feeling frozen.

### 5.3 Composer state

The input area keeps its standard `> ` shape, but also shows a lightweight runtime status such as:

- `status: idle`
- `status: running codex-cli`
- `status: waiting_confirm`
- `status: blocked`

This is informational only; it does not replace transcript-level progress.

---

## 6. Result Presentation

Results must be visually independent from execution logs.

### 6.1 Result header

Examples:

- `✓ 任务完成 (164.7s)`
- `! 任务失败`
- `! 等待确认`

### 6.2 Result body

- starts below the header
- rendered as a coherent block
- does not share the same visual channel as the execution stream

### 6.3 Result tail

If present, append a stable tail section for:

- generated files
- task artifacts
- task id
- referenced materials

---

## 7. Guidance and Confirmation

The existing guidance panel remains useful, but it should feel integrated rather than disconnected.

Rules:
- current recommendation stays visually grouped
- confirmations use warning semantics, not normal system semantics
- when a user decision is required, the composer and the latest event must both surface that requirement

---

## 8. Scope Boundaries

Included in this round:

- semantic block rendering in the transcript
- clearer status and result presentation
- executor progress visibility improvements
- composer state hints
- tests updated to match the new hierarchy

Not included in this round:

- multi-column terminal layout
- real chain-of-thought display
- scheduler logic redesign
- executor protocol redesign

---

## 9. Testing Strategy

### 9.1 Snapshot and semantic rendering

Add or update TUI tests so they assert:

- user blocks remain obvious
- system lines are visually differentiated
- context preparation lines appear grouped
- executor step lines are visible while running
- result blocks start with explicit headers
- confirmation states are clearly surfaced

### 9.2 Dynamic feedback

Cover:

- running task shows stage and/or most recent step
- stalled visible output shows waiting indicator
- completed task separates process logs from result body

### 9.3 Real end-to-end validation

Run real `codex-cli` flows for:

- simple ask-response
- long-running research task
- high-priority preemption
- parked-task resume
- confirmation-required flow

Acceptance bar:
- users can tell who is speaking
- users can tell whether work is progressing
- users can tell where the final answer is

---

## 10. Implementation Strategy

Implement this as an incremental refactor inside `src/tui/app.tsx`:

1. classify output lines into semantic render types
2. introduce shared render helpers for block styling
3. upgrade composer status presentation
4. improve runtime status lines and waiting feedback
5. update tests and run real E2E verification

This keeps the architecture stable while materially improving usability.
