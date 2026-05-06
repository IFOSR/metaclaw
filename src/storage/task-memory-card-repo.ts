import type Database from 'better-sqlite3';

interface TaskMemoryCardRow {
  id: string;
  task_id: string;
  title: string;
  goal: string;
  summary: string;
  key_decisions_json: string;
  changed_files_json: string;
  verification_commands_json: string;
  pitfalls_json: string;
  artifacts_json: string;
  outcome: TaskMemoryCardOutcome;
  source_candidate_id: string | null;
  created_at: string;
  updated_at: string;
}

export type TaskMemoryCardOutcome = 'success' | 'failed' | 'partial' | 'blocked';

export interface TaskMemoryCardRecord {
  id: string;
  taskId: string;
  title: string;
  goal: string;
  summary: string;
  keyDecisions: string[];
  changedFiles: string[];
  verificationCommands: string[];
  pitfalls: string[];
  artifacts: string[];
  outcome: TaskMemoryCardOutcome;
  sourceCandidateId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskMemoryCardInsert extends TaskMemoryCardRecord {}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value || '[]') as unknown;
  return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
}

function rowToTaskMemoryCard(row: TaskMemoryCardRow): TaskMemoryCardRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    goal: row.goal,
    summary: row.summary,
    keyDecisions: parseStringArray(row.key_decisions_json),
    changedFiles: parseStringArray(row.changed_files_json),
    verificationCommands: parseStringArray(row.verification_commands_json),
    pitfalls: parseStringArray(row.pitfalls_json),
    artifacts: parseStringArray(row.artifacts_json),
    outcome: row.outcome,
    sourceCandidateId: row.source_candidate_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface TaskMemoryCardSearchRequest {
  queryText: string;
  currentTaskId: string;
  keywords: string[];
  topK?: number;
}

export interface TaskMemoryCardSearchCandidate extends TaskMemoryCardRecord {
  recallMode: 'resume' | 'reference';
  reason: string;
  score: number;
}

const GENERIC_RECALL_TERMS = new Set([
  '任务',
  '相关',
  '历史',
  '今天',
  '早上',
  '上午',
  '刚才',
  '执行',
  '清单',
  '列出',
  '公司',
  '产品',
  '情况',
  '分析',
  '调研',
  '方案',
  '总结',
  '深度',
  '最新',
  '继续',
]);

function tokenize(input: string): string[] {
  const asciiTokens = input
    .toLowerCase()
    .match(/[a-z0-9_\-]+/g) ?? [];
  const cjkTokens = input
    .split(/[^\u4e00-\u9fff]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
  return Array.from(new Set([...asciiTokens, ...cjkTokens]));
}

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isGenericRecallTerm(token: string): boolean {
  const normalized = token.toLowerCase().trim();
  if (!normalized) {
    return true;
  }
  if (GENERIC_RECALL_TERMS.has(normalized)) {
    return true;
  }
  if (/^[a-z0-9_\-]+$/.test(normalized)) {
    return normalized.length < 3 || GENERIC_RECALL_TERMS.has(normalized);
  }
  return normalized.length < 2;
}

function includesToken(text: string, token: string): boolean {
  return text.toLowerCase().includes(token.toLowerCase());
}

function buildSearchText(card: TaskMemoryCardRecord): string {
  return [
    card.title,
    card.goal,
    card.summary,
    ...card.keyDecisions,
    ...card.changedFiles,
    ...card.verificationCommands,
    ...card.pitfalls,
    ...card.artifacts,
  ].join('\n');
}

function calculateRelevanceScore(card: TaskMemoryCardRecord, request: TaskMemoryCardSearchRequest): number {
  const searchText = buildSearchText(card);
  const titleGoalSummaryText = [card.title, card.goal, card.summary].join('\n');
  const normalizedQueryText = normalizeText(request.queryText);
  const normalizedSearchText = normalizeText(searchText);
  const normalizedTitleGoalSummaryText = normalizeText(titleGoalSummaryText);
  const normalizedKeywords = Array.from(new Set(
    request.keywords
      .map(keyword => keyword.trim())
      .filter(keyword => keyword && !isGenericRecallTerm(keyword)),
  ));
  const queryTokens = tokenize(request.queryText).filter(token => !isGenericRecallTerm(token));
  let score = 0;

  if (normalizedQueryText.length >= 4 && normalizedSearchText.includes(normalizedQueryText)) {
    score += 36;
  }

  for (const keyword of normalizedKeywords) {
    if (includesToken(titleGoalSummaryText, keyword)) {
      score += 34;
    } else if (includesToken(searchText, keyword)) {
      score += 18;
    }
  }

  for (const token of queryTokens) {
    const normalizedToken = normalizeText(token);
    if (!normalizedToken) {
      continue;
    }

    if (normalizedTitleGoalSummaryText.includes(normalizedToken)) {
      score += token.length >= 4 ? 16 : 10;
    } else if (normalizedSearchText.includes(normalizedToken)) {
      score += token.length >= 4 ? 8 : 5;
    }
  }

  if (card.taskId === request.currentTaskId) {
    score += 28;
  }
  if (card.outcome === 'success') {
    score += 10;
  } else if (card.outcome === 'partial') {
    score += 8;
  }
  if (card.artifacts.length > 0) {
    score += 4;
  }
  if (card.verificationCommands.length > 0) {
    score += 4;
  }

  return Math.min(100, score);
}

export class TaskMemoryCardRepo {
  constructor(private readonly db: Database.Database) {}

  insert(record: TaskMemoryCardInsert): void {
    this.db.prepare(`
      INSERT INTO task_memory_cards (
        id, task_id, title, goal, summary, key_decisions_json, changed_files_json,
        verification_commands_json, pitfalls_json, artifacts_json, outcome,
        source_candidate_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        title = excluded.title,
        goal = excluded.goal,
        summary = excluded.summary,
        key_decisions_json = excluded.key_decisions_json,
        changed_files_json = excluded.changed_files_json,
        verification_commands_json = excluded.verification_commands_json,
        pitfalls_json = excluded.pitfalls_json,
        artifacts_json = excluded.artifacts_json,
        outcome = excluded.outcome,
        source_candidate_id = excluded.source_candidate_id,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.taskId,
      record.title,
      record.goal,
      record.summary,
      JSON.stringify(record.keyDecisions),
      JSON.stringify(record.changedFiles),
      JSON.stringify(record.verificationCommands),
      JSON.stringify(record.pitfalls),
      JSON.stringify(record.artifacts),
      record.outcome,
      record.sourceCandidateId,
      record.createdAt,
      record.updatedAt,
    );
  }

  findByTaskId(taskId: string): TaskMemoryCardRecord | null {
    const row = this.db.prepare('SELECT * FROM task_memory_cards WHERE task_id = ?').get(taskId) as TaskMemoryCardRow | undefined;
    return row ? rowToTaskMemoryCard(row) : null;
  }

  listRecent(limit = 10): TaskMemoryCardRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM task_memory_cards
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as TaskMemoryCardRow[];
    return rows.map(rowToTaskMemoryCard);
  }

  searchRelevant(request: TaskMemoryCardSearchRequest): TaskMemoryCardSearchCandidate[] {
    const limit = request.topK ?? 5;
    const rows = this.db.prepare(`
      SELECT * FROM task_memory_cards
      ORDER BY updated_at DESC
    `).all() as TaskMemoryCardRow[];

    return rows
      .map(rowToTaskMemoryCard)
      .map(card => {
        const recallMode = card.taskId === request.currentTaskId ? 'resume' : 'reference';
        const score = calculateRelevanceScore(card, request);
        return {
          ...card,
          recallMode,
          score,
          reason: recallMode === 'resume'
            ? `恢复型召回：当前任务与卡片任务 ${card.taskId} 一致，${card.outcome} 任务状态可用于续接`
            : `参考型召回：历史任务卡片 ${card.taskId} 与当前输入高度相关，outcome=${card.outcome}`,
        } satisfies TaskMemoryCardSearchCandidate;
      })
      .filter(candidate => candidate.score >= 60)
      .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM task_memory_cards').get() as { count: number };
    return row.count;
  }
}
