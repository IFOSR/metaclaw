# Task-Aware Memory and Recall Optimization Plan

> **Status:** Draft for implementation planning  
> **Date:** 2026-05-06  
> **Scope:** Metaclaw related task recall, time-bounded history recall, task memory cards, and context assembly

**Goal:** Upgrade Metaclaw from "similar conversation recall" to a task-aware memory system that can reliably answer questions like "今天早上我让你执行了什么任务", resume related work, distinguish authoritative task records from weak semantic references, and provide execution context that agents can trust.

**Core Diagnosis:** Metaclaw should not rely on model-native memory for task recall. Model memory is useful for preferences and stable personalization, but task recall requires deterministic storage, queryable timelines, structured task state, provenance, and explicit context layering. The application must own memory; the model should only help summarize, classify, rank, and reason over retrieved evidence.

---

## 1. Problem Statement

The current recall system has improved with `timeline` recall, but the broader architecture still mixes several different concepts:

- Recent session history
- Current task history
- Keyword or LLM-ranked similar history
- Time-bounded task history
- Long-term user preference memory
- Material and artifact context

The main failure mode is that a user asks a deterministic historical question, but the system answers from recent session context or weak semantic similarity. Example:

> 今天早上我让你执行了什么任务，列出来今天早上执行的任务清单

Correct behavior:

- Query all task interactions in the Beijing-time morning window.
- Include the Palantir task if it occurred at 2026-05-06 07:31 Beijing time.
- Distinguish actual task records from follow-up clarification turns.
- Tell the executor these are authoritative time-range records.

Incorrect behavior:

- Use only recent session context.
- Find Palantir as "similar history".
- Inject it as "仅供参考，不得覆盖当前任务".
- Let the executor conclude "不能确认这是今天早上的任务".

---

## 2. Survey Summary

### 2.1 Hermes Agent

Hermes Agent uses a layered memory design:

- `MEMORY.md` and `USER.md` for persistent, compact, always-available memory.
- SQLite / FTS-style session search for past sessions.
- Optional external providers such as Mem0, ByteRover, or Supermemory.

**Takeaway for Metaclaw:** Keep small stable memory separate from searchable session/task history. Do not inject every historical detail directly.

Reference:
- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md

### 2.2 Letta / MemGPT

Letta separates memory into:

- Core memory: always in context, usually profile or agent state.
- Archival memory: long-term searchable memory.
- Recall memory: past conversation/event recall.

**Takeaway for Metaclaw:** Task state should have a compact always-available summary, while full historical records should be retrieved only when needed.

Reference:
- https://github.com/letta-ai/letta

### 2.3 Mem0

Mem0 is a standalone memory layer for agents. It typically provides:

- `add` for capturing memories.
- `search` for retrieval.
- LLM-assisted extraction and consolidation.
- Hybrid retrieval across semantic similarity and structured signals.

**Takeaway for Metaclaw:** Memory capture should be explicit and structured after each task or important turn, not only ad hoc retrieval from raw interactions.

Reference:
- https://github.com/mem0ai/mem0

### 2.4 Zep / Graphiti

Graphiti models agent memory as a temporal knowledge graph:

- Episodes are source events.
- Entities and relations are extracted.
- Edges carry temporal validity.
- Retrieval can combine semantic search, keyword search, graph traversal, and time constraints.

**Takeaway for Metaclaw:** Time matters. If a fact or task happened during a specific time window, SQL / temporal filtering must beat semantic similarity.

Reference:
- https://github.com/getzep/graphiti

### 2.5 LangGraph / LangMem

LangGraph distinguishes:

- Thread state / checkpointing for short-term continuity.
- Long-term stores for cross-thread memory.
- Namespaced memory documents with optional semantic search.

**Takeaway for Metaclaw:** Separate current execution state from long-term recall. Do not treat all memory as one flat list.

Reference:
- https://docs.langchain.com/oss/python/langgraph/add-memory

### 2.6 CrewAI Memory

CrewAI memory is organized around agent collaboration:

- Short-term memory.
- Long-term memory.
- Entity memory.
- Contextual memory during task execution.

**Takeaway for Metaclaw:** Different recall targets need different stores and prompts. Entity recall and task recall should not be conflated.

Reference:
- https://docs.crewai.com/en/concepts/memory

### 2.7 Basic Memory / OpenClaw Basic Memory

Basic Memory uses local-first Markdown plus indexing. OpenClaw Basic Memory adds agent-oriented recall:

- Search `MEMORY.md`.
- Search knowledge graph.
- Scan active tasks.
- Auto-recall at session start.
- Auto-capture after interactions.

**Takeaway for Metaclaw:** Active task scanning is a first-class recall path. "Related task recall" should search task records before raw conversation text.

References:
- https://github.com/basicmachines-co/basic-memory
- https://github.com/basicmachines-co/openclaw-basic-memory

### 2.8 Task Orchestrator / Task Managers

MCP Task Orchestrator and similar systems model tasks directly:

- Task / subtask identity.
- Dependencies.
- Status.
- Specialist assignment.
- Handoff summaries.
- Persistent SQLite/Postgres storage.

**Takeaway for Metaclaw:** Task continuity is not just memory. It is a workflow state model with recall.

Reference:
- https://github.com/jpicklyk/task-orchestrator

### 2.9 OpenAI Memory and Conversation State

OpenAI model/platform memory can help with personalization and conversation continuity, but it does not replace application-owned recall:

- Saved memories are useful for stable user preferences.
- Conversation state can preserve a conversation object.
- Neither should be the sole source for task lists, time-bounded records, provenance, or project state.

References:
- https://help.openai.com/en/articles/8590148-memory-in-chatgpt
- https://developers.openai.com/api/docs/guides/conversation-state

---

## 3. Design Principles

1. **Deterministic before semantic.** If a query has time, task, status, project, or entity constraints, use structured SQL filters before LLM similarity.
2. **Tasks are first-class memory objects.** A task is not just a conversation turn; it has intent, state, artifacts, summaries, and timeline.
3. **Separate authoritative context from weak references.** Current task, timeline records, and accepted task memory are authoritative. Keyword/LLM matches are weak references.
4. **Preserve provenance.** Every recalled item should explain where it came from: task id, interaction id, created_at, source table, and recall reason.
5. **Keep prompts layered.** The executor must know whether a record is current task context, time-range history, task memory card, related reference, preference, or material.
6. **Summarize for recall, expand for evidence.** Search compact task memory cards first. Expand raw interactions only when needed.
7. **Timezone is product behavior.** User-facing temporal recall should use the configured user timezone. Current default: Asia/Shanghai / UTC+8.

---

## 4. Target Architecture

### 4.1 Recall Layers

Metaclaw should assemble context in this order:

1. **Current Task Context**
   - Query by `task_id`.
   - Includes recent turns, task summary, latest snapshot, artifacts, dependencies.
   - Highest authority.

2. **Timeline Recall**
   - Query by `created_at` range.
   - Handles "今天早上", "昨天", "上周", "刚才", "今天执行了什么".
   - Source: `interactions`, later also `tasks` and `task_memory_cards`.

3. **Task State Recall**
   - Query by `status`, `updated_at`, `project`, `workspace`, `resource`.
   - Handles "还有哪些没做完", "上次停在哪", "相关任务有哪些".

4. **Task Memory Card Recall**
   - Search compact task summaries.
   - Supports SQL filters, FTS5, embeddings, and LLM rerank.

5. **Entity / Topic Recall**
   - Search by extracted entities such as company, product, person, repo, domain.
   - Example: Palantir, 易寻盘, Hermes Agent, OPC.

6. **Semantic Related References**
   - LLM-ranked or embedding-ranked historical references.
   - Weak authority only.
   - Must not override deterministic recall.

7. **Preferences and Stable Memory**
   - User style, workflow preference, contact facts.
   - Separate from task recall.

8. **Materials and Artifacts**
   - Local files, URLs, generated docs, outputs.
   - Inject excerpts only when relevant.

### 4.2 Context Prompt Layers

The executor prompt should render distinct sections:

```text
当前任务上下文
时间范围任务记录
任务记忆卡片
相关任务状态
实体/主题关联记录
相似历史参考
用户偏好
关联材料
用户最新指令
```

The prompt must explicitly state:

- Timeline records are authoritative for time-bounded historical questions.
- Task memory cards are summarized task records and may be used as historical evidence.
- Similar historical references are weak signals and should not be treated as confirmed facts unless corroborated.

---

## 5. Data Model Changes

### 5.1 `task_memory_cards`

Add a table for compact task-level memory:

```sql
CREATE TABLE IF NOT EXISTS task_memory_cards (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  user_intent TEXT NOT NULL,
  task_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT '',
  next_step TEXT NOT NULL DEFAULT '',
  entities_json TEXT NOT NULL DEFAULT '[]',
  topics_json TEXT NOT NULL DEFAULT '[]',
  resources_json TEXT NOT NULL DEFAULT '[]',
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_interaction_ids_json TEXT NOT NULL DEFAULT '[]'
);
```

Recommended indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_task_memory_cards_task_id
  ON task_memory_cards(task_id);

CREATE INDEX IF NOT EXISTS idx_task_memory_cards_updated_at
  ON task_memory_cards(updated_at);

CREATE INDEX IF NOT EXISTS idx_task_memory_cards_status
  ON task_memory_cards(status);
```

Optional FTS:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS task_memory_cards_fts
USING fts5(title, user_intent, summary, outcome, entities, topics, content='');
```

### 5.2 `interaction_entities`

Optional normalization table:

```sql
CREATE TABLE IF NOT EXISTS interaction_entities (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL,
  task_id TEXT,
  entity TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
```

### 5.3 `recall_events`

Add observability:

```sql
CREATE TABLE IF NOT EXISTS recall_events (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  user_input TEXT NOT NULL,
  recall_type TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  selected_count INTEGER NOT NULL,
  sources_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

---

## 6. Recall Query Semantics

### 6.1 Time-Bounded Queries

Examples:

- 今天早上我让你执行了什么任务？
- 昨天做了哪些事情？
- 列一下上午的任务清单。
- 刚才我让你调研哪个公司？

Behavior:

1. Parse temporal expression.
2. Convert to configured timezone.
3. Query `interactions` and `task_memory_cards`.
4. Group by `task_id`.
5. Classify each record as:
   - actual task request
   - follow-up question
   - assistant answer
   - execution result
6. Return a chronological list with timestamps.

### 6.2 Related Task Queries

Examples:

- 和 Palantir 相关的任务有哪些？
- 上次那个 OPC 方案继续。
- 找一下和 Hermes Agent 记忆机制相关的调研。

Behavior:

1. Extract entities and topics.
2. Search `task_memory_cards` by entity/topic filters.
3. Search FTS text.
4. Search embeddings if available.
5. LLM rerank only after structured candidates are retrieved.
6. Inject top candidates as "任务记忆卡片".

### 6.3 Resume Queries

Examples:

- 继续上次的方案。
- 刚才被打断的任务继续。
- 上次做了一半的文档在哪？

Behavior:

1. Prefer active/running/parked task state.
2. Use latest snapshot and artifacts.
3. Use task memory card for compact recap.
4. Only then search related history.

---

## 7. Ranking Strategy

Recommended scoring:

```text
score =
  0.35 * deterministic_match
+ 0.20 * time_relevance
+ 0.15 * entity_match
+ 0.10 * task_status_relevance
+ 0.10 * semantic_similarity
+ 0.05 * recency
+ 0.05 * user_session_proximity
```

Rules:

- Deterministic timeline records do not need semantic score to be included.
- Exact entity match beats vague semantic similarity.
- Active/parked/running tasks beat archived/done tasks for resume queries.
- Weak references must carry a lower authority label.

---

## 8. Implementation Plan

### Phase 1: Stabilize Deterministic Recall

**Goal:** Make time-bounded and task-status queries reliable before adding more semantic complexity.

Files:

- Modify: `src/core/context-recaller.ts`
- Modify: `src/core/resume-context-builder.ts`
- Modify: `src/executor/prompt-builder.ts`
- Modify: `src/core/types.ts`
- Add tests under `tests/core/` and `tests/executor/`

Tasks:

1. Expand timeline parser beyond "今天早上":
   - 今天
   - 昨天
   - 上午
   - 下午
   - 晚上
   - 刚才
   - 最近 N 小时
2. Add timezone config instead of hard-coded UTC+8.
3. Group timeline recall results by task.
4. Add labels for task request vs follow-up.
5. Add prompt section for authoritative time-range task records.

Acceptance:

- "今天早上我让你执行了什么任务" returns all morning tasks.
- A Palantir task at Beijing 07:31 is included.
- Afternoon tasks are excluded from morning recall.
- Similar semantic results are not used to contradict timeline records.

### Phase 2: Add Task Memory Cards

**Goal:** Create compact task-level summaries that can be searched before raw conversation history.

Files:

- Modify: `src/storage/migrations.ts`
- Add: `src/storage/task-memory-card-repo.ts`
- Add: `src/core/task-memory-card-service.ts`
- Modify: task completion / snapshot logic

Tasks:

1. Add `task_memory_cards` schema.
2. Generate card on task creation.
3. Update card on task completion, park, block, or artifact creation.
4. Extract entities/topics with a deterministic fallback.
5. Add FTS search over card fields.

Acceptance:

- Every completed or parked task has a task memory card.
- Cards include intent, summary, entities, artifacts, next step.
- Related task queries retrieve cards before raw interactions.

### Phase 3: Hybrid Related Task Recall

**Goal:** Build a robust related-task retrieval pipeline.

Files:

- Modify: `src/core/context-recaller.ts`
- Add: `src/core/related-task-recaller.ts`
- Add tests under `tests/core/related-task-recaller.test.ts`

Tasks:

1. Implement candidate sources:
   - SQL task filters
   - time filters
   - entity/topic filters
   - FTS5 text search
   - optional LLM rerank
2. Add reason strings per candidate:
   - `entity_match`
   - `same_project`
   - `time_range`
   - `semantic_similarity`
   - `active_task`
3. Add deduplication by task id.
4. Add authority labels.

Acceptance:

- "Palantir 分析相关任务" retrieves the Palantir task even if recent session mentions another company.
- "OPC 方案相关任务" retrieves OPC tasks without polluting recall with unrelated generic "调研" tasks.
- Each recalled item explains why it was recalled.

### Phase 4: Context Assembly Upgrade

**Goal:** Make executor prompts clear enough that agents do not misuse weak references.

Files:

- Modify: `src/executor/prompt-builder.ts`
- Modify: `src/core/resume-context-builder.ts`
- Add prompt tests

Tasks:

1. Render `时间范围任务记录`.
2. Render `任务记忆卡片`.
3. Render `相关任务状态`.
4. Keep `相似历史参考` capped and weak.
5. Add explicit instruction hierarchy.

Acceptance:

- Prompt has separate authoritative and weak-reference sections.
- Weak references are never labeled as confirmed time/task records.
- Task memory cards are concise and source-linked.

### Phase 5: Observability and Debugging

**Goal:** Make recall behavior inspectable.

Files:

- Add: `src/storage/recall-event-repo.ts`
- Add command: `/recall debug`
- Add tests for recall event logging

Tasks:

1. Log each recall event.
2. Store candidate counts and selected sources.
3. Add a debug command showing:
   - parsed query type
   - time range
   - candidate sources
   - rejected candidates
   - final injected sections

Acceptance:

- A bad recall can be diagnosed from local logs without guessing.
- Users can see why a task was or was not recalled.

---

## 9. Example Target Behavior

User:

```text
今天早上我让你执行了什么任务，列出来今天早上执行的任务清单
```

Metaclaw should retrieve:

```text
时间范围：Asia/Shanghai 2026-05-06 00:00:00 - 2026-05-06 12:00:00

1. 07:31 - task_dIaOBuCeIC
   用户意图：Palantir 最新财报后的商业模式变化、未来前景、转型路径深度调研
   类型：公司调研 / 财报分析
   状态：done

2. 10:43 - task_WJVB367avd
   用户意图：确认今天早上做过的公司调研对象
   类型：历史确认 / follow-up
   状态：done
```

If the user then asks:

```text
我记得是 Palantir 对吗？
```

Metaclaw should answer:

```text
是。按今天早上的时间范围记录，07:31 有一项 Palantir 财报与商业模式变化的深度调研任务。
另外 10:43 的易寻盘是后续关于“今天早上调研哪个公司”的确认对话，不应覆盖 Palantir 任务记录。
```

---

## 10. Risks

1. **Over-capture risk:** Too many low-value task memory cards may pollute recall.
2. **Entity extraction error:** LLM may extract wrong entities; deterministic fallback and review logs are needed.
3. **Timezone ambiguity:** "今天早上" must use user timezone, not server UTC.
4. **Prompt bloat:** Raw history expansion can exceed context; prefer task cards first.
5. **Authority confusion:** If prompt labels are unclear, executor may still over-trust weak references.
6. **Task vs follow-up ambiguity:** A user question can be a task itself or a clarification about a past task; classification needs tests.

---

## 11. Metrics

Track:

- Recall precision for time-bounded queries.
- Recall precision for entity-related task queries.
- Number of weak references injected per task.
- Number of task memory cards generated.
- User correction rate after recall answers.
- Cases where timeline records contradict semantic references.
- Prompt token usage per context section.

Success targets:

- Time-bounded recall precision: >= 95%.
- Entity task recall top-3 hit rate: >= 90%.
- Weak reference pollution: <= 1 unrelated reference per 20 recall queries.
- User correction rate for "what did I ask you to do" queries: trending downward.

---

## 12. Recommended Next Implementation Step

Start with **Phase 2: Task Memory Cards**, because Phase 1 already has an initial `timeline` implementation.

Immediate next tasks:

1. Add `task_memory_cards` migration and repo.
2. Generate task cards from task creation/completion/snapshot data.
3. Add FTS search over card fields.
4. Inject matched cards into a new prompt section.
5. Add regression tests for Palantir / 易寻盘 / OPC scenarios.

This gives Metaclaw a structured recall substrate before adding heavier graph or embedding memory.
