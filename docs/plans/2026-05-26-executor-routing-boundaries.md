# Executor Routing Boundaries

Date: 2026-05-26

## Problem

MetaClaw now has multiple downstream executors:

- `codex-cli`
- `deepseek-tui`
- `hermes-agent`

Their capabilities overlap. All three can handle text, analysis, and some code-related work. A simple keyword score is not enough, because broad words like "analysis", "report", "code", and "automation" can match multiple executors.

The router needs stronger boundaries. It should choose the executor based on task intent, executor ownership, risk, and historical outcomes, not just token matches.

## Executor Ownership

### codex-cli

Primary ownership:

- Local repository editing
- Code implementation
- Tests and test repair
- Bug fixing
- Refactoring
- Patch generation
- Deterministic engineering execution

Good fits:

- "实现这个功能"
- "修这个 bug"
- "跑测试并修复失败"
- "重构这个模块"
- "给这个 PR 做代码审查"
- "把结果写入文件/patch"

Avoid:

- Broad market/company research
- Long-form business reports
- Personal assistant workflows
- Messaging gateway workflows
- Memory-first or cross-session automation

Default rule:

If the task requires modifying the current repo or running tests, prefer `codex-cli` unless the user explicitly asks for DeepSeek reasoning first.

### deepseek-tui

Primary ownership:

- DeepSeek model reasoning
- Chinese technical reasoning
- Algorithmic analysis
- Math and derivation
- Boundary-condition analysis
- Technical review where reasoning depth matters more than deterministic repo mutation
- Terminal-native DeepSeek agent workflows

Good fits:

- "用 DeepSeek 分析"
- "复杂算法推理"
- "数学推导"
- "中文技术分析"
- "分析这段代码的边界条件"
- "做一次深度架构/技术取舍分析"

Avoid:

- Large deterministic repo edits where the main job is implementation
- Multi-source business research
- Memory/gateway/assistant workflows

Default rule:

If the task is mostly technical reasoning, algorithmic analysis, or explicitly asks for DeepSeek, prefer `deepseek-tui`.

If the task also requires repo mutation, split or prefer `codex-cli` unless the user explicitly says to use DeepSeek for the execution.

### hermes-agent

Primary ownership:

- Research workflows
- Multi-tool orchestration
- Persistent memory
- Skill runtime
- MCP/toolset orchestration
- Messaging gateway workflows
- Cross-session assistant workflows
- Workflow automation

Good fits:

- "调研并输出报告"
- "整理多份资料"
- "结合长期记忆"
- "多工具调用"
- "自动化工作流"
- "消息网关/通知/assistant"
- "跨 session 追踪和沉淀"

Avoid:

- Pure local code implementation
- Single-repo deterministic bugfixes
- Algorithm/math-heavy reasoning with no external workflow

Default rule:

If the task is research, report generation, multi-tool automation, memory, skills, or messaging/gateway work, prefer `hermes-agent`.

## Route Intent Types

The router should first classify the task into a primary intent:

- `repo_execution`: modify code, write files, run tests, create patches.
- `technical_reasoning`: algorithm, math, architecture, boundary analysis, technical tradeoffs.
- `research_workflow`: research, report, multi-source synthesis, market/company/product analysis.
- `memory_agent_ops`: persistent memory, skills, gateway, messaging, cross-session workflow.
- `conversation_or_control`: not an executor dispatch target; handled earlier by session routing.

Intent classification should happen before executor scoring.

## Dispatch Rules

Hard rules:

- If `repo_execution` and current repo mutation is required, choose `codex-cli`.
- If `technical_reasoning` and DeepSeek/algorithm/math/Chinese technical reasoning is explicit, choose `deepseek-tui`.
- If `research_workflow`, choose `hermes-agent`.
- If `memory_agent_ops`, choose `hermes-agent`.
- If user explicitly names an executor, route to that executor if available.

Tie-breakers:

- Prefer the executor whose primary ownership matches the intent.
- Use historical success only after intent and ownership match.
- Do not let `historicalSuccess` override a clear ownership mismatch.
- If confidence is medium and action is risky, return `ask_review`.

Conflict handling:

- Code implementation + complex reasoning: default `codex-cli`; optionally ask DeepSeek for analysis first in a future multi-stage route.
- Technical research + DeepSeek named: `deepseek-tui`.
- Market/company/product research + report: `hermes-agent`.
- Automation + code execution but no repo mutation: `hermes-agent` unless DeepSeek is explicitly requested.
- Code review over current repo diff: `codex-cli` by default; `deepseek-tui` if the prompt emphasizes reasoning, algorithms, or Chinese technical review.

## Router Decision Shape

Route decisions should be explainable:

```json
{
  "selectedExecutor": "deepseek-tui",
  "action": "auto_dispatch",
  "confidence": 0.82,
  "primaryIntent": "technical_reasoning",
  "matchedBoundary": [
    "algorithm",
    "chinese_analysis",
    "deepseek_reasoning"
  ],
  "rejected": [
    {
      "executorName": "codex-cli",
      "reason": "task does not require deterministic repo mutation"
    },
    {
      "executorName": "hermes-agent",
      "reason": "no multi-tool research, memory, or gateway requirement"
    }
  ]
}
```

The user-facing TUI can show a short version:

```text
→ 路由决策：deepseek-tui (auto_dispatch, confidence=0.82)
→ 原因：technical_reasoning / algorithm + chinese_analysis + deepseek_reasoning
```

## Implementation Plan

1. Add `TaskRouteIntent` to `src/core/executor-router.ts`.
2. Add intent classifier before candidate scoring.
3. Extend `ExecutorProfile` with optional:
   - `primaryUseCases`
   - `avoidUseCases`
   - `intentAffinity`
4. Make profile scoring intent-aware:
   - intent ownership score
   - domain/capability score
   - explicit executor score
   - risk gate
   - historical tie-breaker
5. Add conflict rules for overlapping executor matches.
6. Record rejected candidates and reasons in route events.
7. Surface route reason in the TUI output.

## Test Matrix

Must cover:

- "修复这个 TypeScript bug 并跑测试" -> `codex-cli`
- "用 DeepSeek 做复杂算法推理，输出中文技术分析" -> `deepseek-tui`
- "调研 AI Agent 市场并输出报告" -> `hermes-agent`
- "结合长期记忆和多工具调用做自动化调研报告" -> `hermes-agent`
- "分析这段代码边界条件，不改文件" -> `deepseek-tui`
- "分析这段代码并直接修复测试" -> `codex-cli`
- "代码 review，重点看算法正确性，用中文解释" -> `deepseek-tui`
- "PR review 并给 patch" -> `codex-cli`
- "消息网关自动通知客户" -> `hermes-agent`

## Non-Goals

- Do not make the router a general LLM agent yet.
- Do not dispatch one task to multiple executors in V1.
- Do not remove user explicit executor override.
- Do not let profile `historicalSuccess` dominate intent ownership.

## Future Option

For hard mixed tasks, support multi-stage routing:

1. `deepseek-tui` produces reasoning or diagnosis.
2. `codex-cli` applies deterministic repo changes.
3. `hermes-agent` handles follow-up workflow, memory, or notifications.

This should be explicit and auditable, not hidden behind a single ambiguous route.
