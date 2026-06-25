---
status: proposed
---

# Capability registry — registration, not scanning

## Context

The user requires MetaClaw to maintain a per-executor capability table that is dynamically updatable: as new MCP services are added, an executor's usable capabilities grow. The legacy `ExecutorProfile.capabilities` field is static (seeded once at startup in `executor-registry-seeder.ts`, never written back) and mixes model-level abilities (`deepseek_reasoning`) with tool-level ones — so it cannot serve as the dynamic, tool-boundary table the new routing needs.

The user is explicit that MetaClaw must **not** proactively scan for available capabilities: different MCP services start up and register differently, and scanning would miss things. Capabilities are registered at add-time. A manually-installed MCP not registered in MetaClaw is treated as unavailable by default.

## Decision

1. **Registration, not scanning.** The capability table is updated only when a capability is explicitly registered. MetaClaw never auto-discovers MCP tools. A capability absent from the registry is treated as not-available. MetaClaw scans/tests/registers only when the user explicitly asks.

2. **Add-new-MCP flow (registration is the final step):**
   1. User states the need.
   2. MetaClaw decides which executor owns it (routing decision → `ExecutionPolicy`).
   3. Executor accepts the task and pulls the MCP service.
   4. Executor downloads the tool, debugs it; auth steps requiring manual action are surfaced to the user (human-in-the-loop).
   5. Executor confirms it runs and returns the **invocation method** to MetaClaw.
   6. MetaClaw registers the capability into the registry, updating the table.

3. **Data source for registration:** the executor self-reports (it tested the tool itself), the user confirms before commit. The user may optionally run a manual verification of the capability before confirming, or commit directly. **Self-test thoroughness is the executor's concern — deferred, not specified here.**

4. **Out-of-band verification is allowed (required by ADR-0004 / #69994).** Because an executor claiming "installed/success" is not proof (GitHub #69994: Write reports success without persisting), the registration flow must permit verifying the result from an independent process. The "user may manually verify" step is not just courtesy — it is the defense against false self-report.

## Considered Options

- **Auto-scan on startup / on a timer.** Rejected: the user explicitly forbids it. Different MCP services register differently; scanning misses things and cannot be relied on.
- **MetaClaw verifies each capability before registering.** Rejected: this collapses back into MetaClaw doing discovery/validation — exactly the scanning the user rejected. Verification is the *user's* option, executed out-of-band, not MetaClaw's automatic probe.
- **Trust the executor's self-report unconditionally.** Rejected: #69994 shows self-report can be false. The user-confirm step (with optional manual verification) is the safeguard.

## Consequences

- **The invocation-method granularity is deliberately undecided.** Whether the registry stores tool-level call contracts, capability-level summaries, or both is left to the executor's own choice or a later decision (per the user: "到时候由执行器自行决定"). This ADR fixes only the *flow* (executor returns it → MetaClaw registers it → user confirms), not the stored shape.
- The capability table's storage likely reuses `ExecutorProfile.capabilities` (writable via `executor-profile-repo.upsert`) but must be cleansed of model-level entries. Whether it becomes a distinct table or a cleaned view of the profile is an implementation detail not fixed here.
- Registration maps a capability to a `CapabilityClass` (ADR-0008) at registration time — the mapping is recorded then, not inferred at routing time.
- The capability table is a **prior** (what's registered), not a **posterior** (what succeeded). It does not feed ADR-0005's success-rate signal — that comes from `executor_route_events.result`. The two must not be conflated: registry = "can this executor do X," route events = "how well did it do X lately."
