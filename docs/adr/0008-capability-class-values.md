---
status: proposed
---

# CapabilityClass values — seven, by tool/side-effect boundary

## Context

ADR-0002 introduces `CapabilityClass` to supersede `TaskRouteIntent`, but left the concrete enum values open. The legacy `TaskRouteIntent` (`repo_execution | technical_reasoning | research_workflow | memory_agent_ops | conversation_or_control | general`) was the index key of the abolished affinity-scoring model, and its granularity is wrong for the new selection principle: it has no office/automation class (misfiled under `memory_agent_ops`/`general`), and it treats `technical_reasoning` (a model-level capability) as a routing class — which the user rejected: reasoning is a model ability, not a harness routing concern.

## Decision

`CapabilityClass` has seven values, defined by **tool/side-effect boundary**, not by executor strength:

| Value | Meaning (what tool/side-effect the task needs) | Executors covering it today |
|---|---|---|
| `code_edit` | local repo file modification + test/build | codex-cli, claude-code, deepseek-tui |
| `research` | web search + synthesis into prose | pi-agent, hermes-agent |
| `messaging` | Feishu / messaging-gateway send | hermes-agent |
| `memory_ops` | cross-session memory read/write | hermes-agent |
| `office_automation` | multi-tool orchestration / workflow automation | hermes-agent |
| `conversation` | no tool — pure chat / control / clarification | MetaClaw itself |
| `general` | fallback when no class fits | — |

`reasoning` is **deliberately excluded** — it is a model-level capability (every agent reasons), not a tool/side-effect boundary. Routing to "reasoning" would conflate abstraction layers.

## Considered Options

- **Reuse `TaskRouteIntent` values.** Rejected (ADR-0002): bound to the dead affinity model, wrong granularity.
- **Split `research` into `web_research` + `report_writing`.** Rejected: research almost always accompanies output; splitting forces the router to judge "does this research need a report," which is rarely clear. One `research` class keeps the side-effect boundary clean.
- **Add `file_io` / `external_api`.** Rejected as separate classes: `file_io` overlaps `code_edit`'s side-effect surface; `external_api` is too broad (covered by `office_automation`). No additional classes are needed yet.
- **Keep `reasoning` as a class.** Rejected by the user: reasoning is a model ability, not a harness routing class.

## Consequences

- Some `CapabilityClass` values have only one covering executor today (e.g. `messaging` → hermes-agent). For these, "select among same-class peers" (ADR-0005) is vacuous — there is no peer. Such single-executor classes skip selection and dispatch directly. This is the "special-function task" case the user flagged as "暂不设置审核" (ADR-0007) when only one executor has the capability.
- New MCP tools (registered per ADR-0009) may add executors to existing classes or motivate new classes. The enum is the boundary that defines complementary-vs-redundant; adding a class is a deliberate change, not automatic.
- The mapping from a registered capability to a `CapabilityClass` (e.g. an MCP tool that "sends Feishu messages" → `messaging`) is a registration-time decision, recorded when the capability is registered, not inferred at routing time.
