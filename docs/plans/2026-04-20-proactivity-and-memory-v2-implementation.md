# Proactivity And Memory V2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build V2 actionable proposals, recall review, dual-layer memory, and hybrid embedding recall on top of the current Metaclaw runtime.

**Architecture:** Add a new proposal/review layer between orchestration and execution. Keep proactive proposals, task memory recall, and preference memory recall independent but unify them through a review-and-accept flow before execution context injection. Use cloud embedding generation with local SQLite persistence and local reranking so the product flow is complete before any future model localization.

**Tech Stack:** TypeScript, Node.js, Ink, better-sqlite3, Vitest, SQLite JSON fields, cloud embedding API abstraction

---

### Task 1: Add V2 Schema And Core Types

**Files:**
- Modify: `src/storage/migrations.ts`
- Modify: `src/core/types.ts`
- Test: `tests/core/v2-schema-types.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';

describe('V2 schema', () => {
  it('creates guidance and memory review tables', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const tableNames = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all().map((row: { name: string }) => row.name);

    expect(tableNames).toContain('guidance_events');
    expect(tableNames).toContain('task_relations');
    expect(tableNames).toContain('task_memory_embeddings');
    expect(tableNames).toContain('preference_embeddings');
    expect(tableNames).toContain('memory_recall_events');
    expect(tableNames).toContain('recall_review_policies');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/v2-schema-types.test.ts`

Expected: FAIL because the new tables do not exist.

**Step 3: Write minimal implementation**

Add a new migration in `src/storage/migrations.ts` that creates:

```sql
CREATE TABLE IF NOT EXISTS guidance_events (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  task_id TEXT,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  reasons_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL DEFAULT 0,
  requires_confirmation INTEGER DEFAULT 1,
  accepted_at TEXT,
  dismissed_at TEXT,
  executed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_relations (
  id TEXT PRIMARY KEY,
  source_task_id TEXT NOT NULL,
  target_task_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_memory_embeddings (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  memory_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS preference_embeddings (
  id TEXT PRIMARY KEY,
  preference_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_recall_events (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  query_text TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  task_candidates_json TEXT NOT NULL DEFAULT '[]',
  preference_candidates_json TEXT NOT NULL DEFAULT '[]',
  review_summary_json TEXT NOT NULL DEFAULT '{}',
  accepted_candidates_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recall_review_policies (
  id TEXT PRIMARY KEY,
  policy_type TEXT NOT NULL,
  scope TEXT,
  subject TEXT,
  proposal_type TEXT,
  auto_apply INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Extend `src/core/types.ts` with:

- `GuidanceProposal`
- `RecallReviewCard`
- `TaskMemoryCandidate`
- `PreferenceMemoryCandidate`
- `RecallReviewPolicy`

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/v2-schema-types.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/storage/migrations.ts src/core/types.ts tests/core/v2-schema-types.test.ts
git commit -m "feat: add v2 proactivity and memory schema"
```

### Task 2: Add Proposal And Recall Review Repositories

**Files:**
- Create: `src/storage/guidance-repo.ts`
- Create: `src/storage/recall-review-policy-repo.ts`
- Create: `src/storage/task-relation-repo.ts`
- Test: `tests/storage/v2-repos.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { GuidanceRepo } from '../../src/storage/guidance-repo.js';

describe('GuidanceRepo', () => {
  it('persists a proposal lifecycle event', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new GuidanceRepo(db);

    repo.insert({
      id: 'guid_1',
      trigger: 'startup',
      taskId: 'task_1',
      actionType: 'resume_task',
      payload: { taskId: 'task_1' },
      reasons: ['材料已齐'],
      confidence: 0.92,
      requiresConfirmation: true,
      acceptedAt: null,
      dismissedAt: null,
      executedAt: null,
      createdAt: '2026-04-20T00:00:00Z',
    });

    const row = repo.findById('guid_1');
    expect(row?.actionType).toBe('resume_task');
    expect(row?.reasons).toEqual(['材料已齐']);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/storage/v2-repos.test.ts`

Expected: FAIL because the repositories do not exist.

**Step 3: Write minimal implementation**

Implement strongly typed repositories with JSON serialization boundaries:

```ts
export class GuidanceRepo {
  constructor(private db: Database.Database) {}

  insert(event: GuidanceEventRecord): void {
    this.db.prepare(`
      INSERT INTO guidance_events (
        id, trigger, task_id, action_type, payload_json, reasons_json,
        confidence, requires_confirmation, accepted_at, dismissed_at,
        executed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.trigger,
      event.taskId,
      event.actionType,
      JSON.stringify(event.payload),
      JSON.stringify(event.reasons),
      event.confidence,
      event.requiresConfirmation ? 1 : 0,
      event.acceptedAt,
      event.dismissedAt,
      event.executedAt,
      event.createdAt,
    );
  }
}
```

Do the same for:

- recall review policies
- task relations

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/storage/v2-repos.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/storage/guidance-repo.ts src/storage/recall-review-policy-repo.ts src/storage/task-relation-repo.ts tests/storage/v2-repos.test.ts
git commit -m "feat: add v2 guidance and review repositories"
```

### Task 3: Build Task Signal Service And Proposal Engine

**Files:**
- Create: `src/core/task-signal-service.ts`
- Create: `src/core/guidance-policy-engine.ts`
- Modify: `src/core/orchestration.ts`
- Test: `tests/core/guidance-policy-engine.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { GuidancePolicyEngine } from '../../src/core/guidance-policy-engine.js';

describe('GuidancePolicyEngine', () => {
  it('proposes resume_task for a high-value parked task with ready materials', () => {
    const engine = new GuidancePolicyEngine();

    const proposals = engine.build([
      {
        taskId: 'task_1',
        status: 'parked',
        isReady: true,
        progressRatio: 0.7,
        idleHours: 3,
        blocksOthers: false,
        hasNewMaterials: false,
        resumability: 'high',
        lastInterruptionReason: '被更高优先级任务抢占：紧急任务',
      },
    ]);

    expect(proposals[0]?.actionType).toBe('resume_task');
    expect(proposals[0]?.requiresConfirmation).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/guidance-policy-engine.test.ts`

Expected: FAIL because the engine does not exist.

**Step 3: Write minimal implementation**

`TaskSignalService` should derive:

```ts
export interface TaskSignal {
  taskId: string;
  status: Task['status'];
  isReady: boolean;
  progressRatio: number;
  idleHours: number;
  blocksOthers: boolean;
  hasNewMaterials: boolean;
  resumability: 'low' | 'medium' | 'high';
  lastInterruptionReason: string;
}
```

`GuidancePolicyEngine` should start with simple deterministic rules:

- parked + resumability high => `resume_task`
- blocked + hasNewMaterials => `unblock_and_resume`
- done + related ready task => `continue_followup`
- ready + highest score => `prioritize_task`

Then wire `src/core/orchestration.ts` to produce proposal objects instead of plain suggestions.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/guidance-policy-engine.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/core/task-signal-service.ts src/core/guidance-policy-engine.ts src/core/orchestration.ts tests/core/guidance-policy-engine.test.ts
git commit -m "feat: add proposal-based guidance engine"
```

### Task 4: Add Recall Review Builder And Policy Service

**Files:**
- Create: `src/core/recall-review-builder.ts`
- Create: `src/core/recall-policy-service.ts`
- Test: `tests/core/recall-review-builder.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { RecallReviewBuilder } from '../../src/core/recall-review-builder.js';

describe('RecallReviewBuilder', () => {
  it('builds a summary card instead of dumping raw candidates', () => {
    const builder = new RecallReviewBuilder();

    const card = builder.build({
      taskCandidates: [{
        kind: 'similar_task',
        title: '上周 Phoenix 周报',
        summary: '结构和当前周报高度相似，可复用栏目顺序',
        reason: '与当前任务目标相似',
      }],
      preferenceCandidates: [{
        scope: 'project',
        summary: 'Phoenix 统一使用 Phoenix 术语体系',
        reason: '项目术语语义相近',
      }],
    });

    expect(card.taskMemorySummary.length).toBe(1);
    expect(card.preferenceMemorySummary.length).toBe(1);
    expect(JSON.stringify(card)).not.toContain('vector');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/recall-review-builder.test.ts`

Expected: FAIL because the builder does not exist.

**Step 3: Write minimal implementation**

Implement summary-only review output:

```ts
export interface RecallReviewCard {
  taskMemorySummary: Array<{
    label: string;
    summary: string;
    reason: string;
  }>;
  preferenceMemorySummary: Array<{
    scope: string;
    summary: string;
    reason: string;
  }>;
  options: ['accept_all', 'reject_all', 'edit', 'select_partial', 'auto_apply_future'];
}
```

`RecallPolicyService` should answer:

- whether this review must be shown
- whether a user previously allowed auto-apply for this review category

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/recall-review-builder.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/core/recall-review-builder.ts src/core/recall-policy-service.ts tests/core/recall-review-builder.test.ts
git commit -m "feat: add recall review summaries and policy service"
```

### Task 5: Add Preference Embedding Infrastructure

**Files:**
- Create: `src/core/embedding-provider.ts`
- Create: `src/core/preference-embedding-service.ts`
- Create: `src/storage/preference-embedding-repo.ts`
- Modify: `src/core/memory-engine.ts`
- Test: `tests/core/preference-embedding-service.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { PreferenceEmbeddingService } from '../../src/core/preference-embedding-service.js';

describe('PreferenceEmbeddingService', () => {
  it('stores vectors for confirmed preferences only', async () => {
    const provider = { embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]) };
    const repo = { upsert: vi.fn() };

    const service = new PreferenceEmbeddingService(provider as any, repo as any);
    await service.embedPreference({
      id: 'pref_1',
      content: '给张总的内容使用正式语气',
      status: 'confirmed',
    } as any);

    expect(provider.embed).toHaveBeenCalled();
    expect(repo.upsert).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/preference-embedding-service.test.ts`

Expected: FAIL because embedding infrastructure does not exist.

**Step 3: Write minimal implementation**

Define the provider boundary:

```ts
export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}
```

Implement a cloud-backed provider adapter plus a repo that stores:

- provider
- model
- dimension
- vector JSON
- content hash

Update `MemoryEngine` so:

- add / confirm / edit can enqueue embedding refresh
- recall still works if no embedding exists

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/preference-embedding-service.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/core/embedding-provider.ts src/core/preference-embedding-service.ts src/storage/preference-embedding-repo.ts src/core/memory-engine.ts tests/core/preference-embedding-service.test.ts
git commit -m "feat: add preference embedding infrastructure"
```

### Task 6: Add Task Memory Embedding Infrastructure

**Files:**
- Create: `src/core/task-embedding-service.ts`
- Create: `src/storage/task-memory-embedding-repo.ts`
- Modify: `src/core/resume-context-builder.ts`
- Test: `tests/core/task-embedding-service.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { TaskEmbeddingService } from '../../src/core/task-embedding-service.js';

describe('TaskEmbeddingService', () => {
  it('embeds task summary documents for semantic recall', async () => {
    const provider = { embed: vi.fn().mockResolvedValue([[0.9, 0.1]]) };
    const repo = { upsert: vi.fn() };

    const service = new TaskEmbeddingService(provider as any, repo as any);
    await service.embedTaskDocument({
      taskId: 'task_1',
      memoryKind: 'task_summary',
      sourceId: 'task_1',
      text: 'Phoenix 周报，已整理风险栏目，待补经营数据',
    });

    expect(repo.upsert).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/task-embedding-service.test.ts`

Expected: FAIL because task embedding infrastructure does not exist.

**Step 3: Write minimal implementation**

Task embedding documents should start with:

- task title
- goal
- latest summary
- latest snapshot summary
- material summary

Do not embed raw interactions yet. Keep V2 scope tight.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/task-embedding-service.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/core/task-embedding-service.ts src/storage/task-memory-embedding-repo.ts src/core/resume-context-builder.ts tests/core/task-embedding-service.test.ts
git commit -m "feat: add task memory embedding infrastructure"
```

### Task 7: Build Hybrid Memory Recaller

**Files:**
- Create: `src/core/hybrid-memory-recaller.ts`
- Modify: `src/core/memory-engine.ts`
- Modify: `src/core/context-recaller.ts`
- Test: `tests/core/hybrid-memory-recaller.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { HybridMemoryRecaller } from '../../src/core/hybrid-memory-recaller.js';

describe('HybridMemoryRecaller', () => {
  it('merges rule recall and semantic recall before building review candidates', async () => {
    const recaller = new HybridMemoryRecaller();

    const result = await recaller.merge({
      rulePreferenceCandidates: [{ id: 'pref_rule', score: 200 }],
      semanticPreferenceCandidates: [{ id: 'pref_sem', score: 0.81 }],
      ruleTaskCandidates: [{ id: 'task_rule', score: 100 }],
      semanticTaskCandidates: [{ id: 'task_sem', score: 0.88 }],
    } as any);

    expect(result.preferenceCandidates.map((x: any) => x.id)).toContain('pref_rule');
    expect(result.taskCandidates.map((x: any) => x.id)).toContain('task_sem');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/hybrid-memory-recaller.test.ts`

Expected: FAIL because the recaller does not exist.

**Step 3: Write minimal implementation**

Implement:

- rule candidate ingestion
- embedding candidate ingestion
- dedupe by id
- rerank by:
  - scope priority
  - exact subject match
  - keyword match
  - semantic score
  - task continuity bonus

Persist recall audit in `memory_recall_events`.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/hybrid-memory-recaller.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/core/hybrid-memory-recaller.ts src/core/memory-engine.ts src/core/context-recaller.ts tests/core/hybrid-memory-recaller.test.ts
git commit -m "feat: add hybrid rule and semantic memory recall"
```

### Task 8: Wire Proposal Acceptance And Recall Review Into Session/TUI

**Files:**
- Modify: `src/session/metaclaw-session.ts`
- Modify: `src/tui/app.tsx`
- Modify: `src/commands/memory-commands.ts`
- Test: `tests/session/v2-proposal-and-recall-review.test.ts`
- Test: `tests/tui/v2-recall-review-visibility.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

describe('V2 proposal flow', () => {
  it('requires proposal confirmation and recall review before execution', async () => {
    // Set up a session with:
    // 1. a generated resume proposal
    // 2. a recall review card
    // 3. a fake executor
    // Assert:
    // - first y accepts proposal only
    // - second y accepts recall review
    // - only then executor runs
    expect(true).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/session/v2-proposal-and-recall-review.test.ts tests/tui/v2-recall-review-visibility.test.ts`

Expected: FAIL

**Step 3: Write minimal implementation**

In `src/session/metaclaw-session.ts`:

- add pending proposal state
- add pending recall review state
- route `y/n/r/e/s/a` according to current pending state
- ensure accepted recall items become the only items injected into `ExecutionContextBundle`

In `src/tui/app.tsx`:

- render proposal blocks
- render recall review blocks
- render when auto-apply policy was used instead of review

In `src/commands/memory-commands.ts`:

- add `/memory review-policy`
- add `/memory review-policy revoke <id>`

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/session/v2-proposal-and-recall-review.test.ts tests/tui/v2-recall-review-visibility.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/session/metaclaw-session.ts src/tui/app.tsx src/commands/memory-commands.ts tests/session/v2-proposal-and-recall-review.test.ts tests/tui/v2-recall-review-visibility.test.ts
git commit -m "feat: add proposal confirmation and recall review flow"
```

### Task 9: Documentation And Acceptance Coverage

**Files:**
- Modify: `README.md`
- Modify: `docs/metaclaw-os_prd_v2_memory_and_proactivity.md`
- Create: `examples/e2e/round-16-proposal-and-recall-review/README.md`
- Create: `examples/e2e/round-16-proposal-and-recall-review/scripts/00-proposal-and-review-smoke.txt`

**Step 1: Write the failing acceptance note**

Add an acceptance checklist covering:

- proposal acceptance
- recall review summary
- auto-apply policy
- hybrid preference recall
- task memory similarity recall

**Step 2: Run smoke path manually**

Run: `node dist/index.js --script examples/e2e/round-16-proposal-and-recall-review/scripts/00-proposal-and-review-smoke.txt`

Expected: current output missing proposal/review states

**Step 3: Update docs**

Document:

- the new proposal flow
- recall review interaction model
- policy management commands
- what gets embedded and what does not

**Step 4: Re-run smoke path**

Run: `node dist/index.js --script examples/e2e/round-16-proposal-and-recall-review/scripts/00-proposal-and-review-smoke.txt`

Expected: PASS-like transcript showing proposal -> recall review -> execution

**Step 5: Commit**

```bash
git add README.md docs/metaclaw-os_prd_v2_memory_and_proactivity.md examples/e2e/round-16-proposal-and-recall-review/README.md examples/e2e/round-16-proposal-and-recall-review/scripts/00-proposal-and-review-smoke.txt
git commit -m "docs: add v2 proposal and memory review acceptance flow"
```

