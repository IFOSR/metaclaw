import type Database from 'better-sqlite3';
import type { ConversationTurn } from '../executor/adapter.js';
import type { LlmBridge } from './llm-bridge.js';

const TASK_HISTORY_LIMIT = 10;
const SESSION_HISTORY_LIMIT = 5;
const KEYWORD_HISTORY_LIMIT = 1;
const LLM_CANDIDATE_LIMIT = 20;
const LLM_RESULT_LIMIT = 5;
const TIMELINE_HISTORY_LIMIT = 20;
const OUTPUT_TRUNCATE_LENGTH = 150;
const CHINA_TIMEZONE_OFFSET_MS = 8 * 60 * 60 * 1000;

interface RecallInput {
  taskId: string;
  sessionId: string;
  userInput: string;
}

interface InteractionRow {
  id: string;
  task_id: string;
  user_input: string;
  system_output: string;
  created_at: string;
}

interface TimelineRange {
  startIso: string;
  endIso: string;
}

function truncateOutput(output: string): string {
  if (output.length <= OUTPUT_TRUNCATE_LENGTH) return output;
  return output.slice(0, OUTPUT_TRUNCATE_LENGTH) + '...';
}

function toTurn(row: InteractionRow, source: ConversationTurn['source']): ConversationTurn {
  return {
    taskId: row.task_id,
    userInput: row.user_input,
    systemOutput: truncateOutput(row.system_output),
    createdAt: row.created_at,
    source,
  };
}

function toChinaDateParts(date: Date): { year: number; month: number; day: number } {
  const chinaTime = new Date(date.getTime() + CHINA_TIMEZONE_OFFSET_MS);
  return {
    year: chinaTime.getUTCFullYear(),
    month: chinaTime.getUTCMonth(),
    day: chinaTime.getUTCDate(),
  };
}

function fromChinaLocalTimeToUtcIso(
  parts: { year: number; month: number; day: number },
  hour: number,
): string {
  const utcTime = Date.UTC(parts.year, parts.month, parts.day, hour) - CHINA_TIMEZONE_OFFSET_MS;
  return new Date(utcTime).toISOString();
}

function shiftChinaDate(
  parts: { year: number; month: number; day: number },
  dayOffset: number,
): { year: number; month: number; day: number } {
  const shiftedUtc = Date.UTC(parts.year, parts.month, parts.day + dayOffset);
  const shifted = new Date(shiftedUtc);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

export class ContextRecaller {
  constructor(
    private db: Database.Database,
    private llmBridge?: LlmBridge,
  ) {}

  /**
   * 三层召回，返回去重、排序后的对话上下文
   */
  recall(input: RecallInput): ConversationTurn[] {
    const seenIds = new Set<string>();
    const result: ConversationTurn[] = [];

    // 第一层：当前任务历史
    const taskHistory = this.recallForTask(input.taskId);
    for (const row of taskHistory) {
      seenIds.add(row.id);
      result.push(toTurn(row, 'task'));
    }

    // 第二层：时间限定记忆查询。必须优先于近期会话，避免权威时间记录被降级为 session。
    const timelineRange = this.detectTimelineRange(input.userInput);
    if (timelineRange) {
      const timelineHistory = this.recallByTimeline(timelineRange, input.taskId, seenIds);
      for (const row of timelineHistory) {
        seenIds.add(row.id);
        result.push(toTurn(row, 'timeline'));
      }
    }

    // 第三层：会话近期历史（排除当前任务）
    const sessionHistory = this.recallForSession(input.sessionId, input.taskId);
    for (const row of sessionHistory) {
      if (!seenIds.has(row.id)) {
        seenIds.add(row.id);
        result.push(toTurn(row, 'session'));
      }
    }

    // 第四层：关键词关联历史
    const keywords = this.extractKeywords(input.userInput);
    if (keywords.length > 0) {
      const keywordHistory = this.recallByKeywords(keywords, seenIds);
      for (const row of keywordHistory) {
        seenIds.add(row.id);
        result.push(toTurn(row, 'keyword'));
      }
    }

    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * 异步召回：第三层优先用 LLM 排序，失败时 fallback 到 bigram
   */
  async recallAsync(input: RecallInput): Promise<ConversationTurn[]> {
    const seenIds = new Set<string>();
    const result: ConversationTurn[] = [];

    // 第一层：当前任务历史
    const taskHistory = this.recallForTask(input.taskId);
    for (const row of taskHistory) {
      seenIds.add(row.id);
      result.push(toTurn(row, 'task'));
    }

    // 第二层：时间限定记忆查询。必须优先于近期会话，避免权威时间记录被降级为 session。
    const timelineRange = this.detectTimelineRange(input.userInput);
    if (timelineRange) {
      const timelineHistory = this.recallByTimeline(timelineRange, input.taskId, seenIds);
      for (const row of timelineHistory) {
        seenIds.add(row.id);
        result.push(toTurn(row, 'timeline'));
      }
    }

    // 第三层：会话近期历史
    const sessionHistory = this.recallForSession(input.sessionId, input.taskId);
    for (const row of sessionHistory) {
      if (!seenIds.has(row.id)) {
        seenIds.add(row.id);
        result.push(toTurn(row, 'session'));
      }
    }

    // 第四层：LLM 排序 → fallback bigram
    if (this.llmBridge) {
      const llmTurns = await this.recallByLlm(input.userInput, seenIds);
      if (llmTurns.length > 0) {
        for (const turn of llmTurns) {
          result.push(turn);
        }
        return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      }
    }

    // fallback: bigram 关键词匹配
    const keywords = this.extractKeywords(input.userInput);
    if (keywords.length > 0) {
      const keywordHistory = this.recallByKeywords(keywords, seenIds);
      for (const row of keywordHistory) {
        seenIds.add(row.id);
        result.push(toTurn(row, 'keyword'));
      }
    }

    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  recallForTaskIds(taskIds: string[], limitPerTask = 3): ConversationTurn[] {
    const uniqueTaskIds = Array.from(new Set(taskIds.filter(Boolean)));
    if (uniqueTaskIds.length === 0) {
      return [];
    }

    const turns: ConversationTurn[] = [];
    for (const taskId of uniqueTaskIds) {
      const rows = this.db.prepare(
        'SELECT id, task_id, user_input, system_output, created_at FROM interactions WHERE task_id = ? ORDER BY created_at DESC LIMIT ?'
      ).all(taskId, limitPerTask) as InteractionRow[];
      turns.push(...rows.map(row => toTurn(row, 'task')));
    }

    return turns.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async recallByLlm(userInput: string, excludeIds: Set<string>): Promise<ConversationTurn[]> {
    try {
      const candidates = this.db.prepare(
        'SELECT id, task_id, user_input FROM interactions ORDER BY created_at DESC LIMIT ?'
      ).all(LLM_CANDIDATE_LIMIT) as Array<{ id: string; task_id: string; user_input: string }>;

      const filtered = candidates.filter(c => !excludeIds.has(c.id));
      if (filtered.length === 0) return [];

      const rankedIds = await this.llmBridge!.rankInteractions(
        userInput,
        filtered.map(c => ({ id: c.id, userInput: c.user_input })),
      );

      if (rankedIds.length === 0) return [];

      const placeholders = rankedIds.slice(0, LLM_RESULT_LIMIT).map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT id, task_id, user_input, system_output, created_at FROM interactions WHERE id IN (${placeholders})`
      ).all(...rankedIds.slice(0, LLM_RESULT_LIMIT)) as InteractionRow[];

      return rows.map(row => {
        excludeIds.add(row.id);
        return toTurn(row, 'llm');
      });
    } catch {
      return [];
    }
  }

  private recallForTask(taskId: string): InteractionRow[] {
    return this.db.prepare(
      'SELECT id, task_id, user_input, system_output, created_at FROM interactions WHERE task_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(taskId, TASK_HISTORY_LIMIT) as InteractionRow[];
  }

  private recallForSession(sessionId: string, excludeTaskId: string): InteractionRow[] {
    return this.db.prepare(
      'SELECT id, task_id, user_input, system_output, created_at FROM interactions WHERE session_id = ? AND (task_id IS NULL OR task_id != ?) ORDER BY created_at DESC LIMIT ?'
    ).all(sessionId, excludeTaskId, SESSION_HISTORY_LIMIT) as InteractionRow[];
  }

  private recallByTimeline(
    range: TimelineRange,
    excludeTaskId: string,
    excludeIds: Set<string>,
  ): InteractionRow[] {
    const rows = this.db.prepare(
      'SELECT id, task_id, user_input, system_output, created_at FROM interactions WHERE created_at >= ? AND created_at < ? AND (task_id IS NULL OR task_id != ?) ORDER BY created_at ASC LIMIT ?'
    ).all(range.startIso, range.endIso, excludeTaskId, TIMELINE_HISTORY_LIMIT) as InteractionRow[];

    return rows.filter(row => !excludeIds.has(row.id));
  }

  private detectTimelineRange(input: string, now = new Date()): TimelineRange | null {
    if (!this.isTimelineRecallRequest(input)) {
      return null;
    }

    const today = toChinaDateParts(now);
    const targetDay = /昨天/u.test(input) ? shiftChinaDate(today, -1) : today;
    const isMorning = /(早上|上午)/u.test(input);

    return {
      startIso: fromChinaLocalTimeToUtcIso(targetDay, 0),
      endIso: fromChinaLocalTimeToUtcIso(targetDay, isMorning ? 12 : 24),
    };
  }

  private isTimelineRecallRequest(input: string): boolean {
    const hasTimeSignal = /(今天早上|今天上午|今天|昨天|早上|上午)/u.test(input);
    const hasRecallIntent = /(执行了什么|做了什么|让我执行|让我做|任务清单|列出来|列出|清单|今天.*任务|昨天.*任务)/u.test(input);
    return hasTimeSignal && hasRecallIntent;
  }

  private recallByKeywords(keywords: string[], excludeIds: Set<string>): InteractionRow[] {
    const results: InteractionRow[] = [];
    for (const keyword of keywords) {
      if (results.length >= KEYWORD_HISTORY_LIMIT) break;
      const rows = this.db.prepare(
        'SELECT id, task_id, user_input, system_output, created_at FROM interactions WHERE user_input LIKE ? ORDER BY created_at DESC LIMIT ?'
      ).all(`%${keyword}%`, KEYWORD_HISTORY_LIMIT) as InteractionRow[];
      for (const row of rows) {
        if (!excludeIds.has(row.id) && results.length < KEYWORD_HISTORY_LIMIT) {
          excludeIds.add(row.id);
          results.push(row);
        }
      }
    }
    return results;
  }

  private extractKeywords(input: string): string[] {
    const stopWords = new Set(['的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', '什么', '为什么', '怎么', '做了', '让你', '刚才', '之前', '那个', '还记得']);
    const keywords: string[] = [];
    const seen = new Set<string>();

    // 先按标点和空格分段
    const segments = input.split(/[\s，。？！、；：""''（）\[\]{}]+/).filter(Boolean);

    for (const seg of segments) {
      // 英文/数字/带连字符的词：整词保留
      if (/^[a-zA-Z0-9][\w-]*$/.test(seg) && seg.length >= 2) {
        if (!seen.has(seg.toLowerCase())) {
          seen.add(seg.toLowerCase());
          keywords.push(seg);
        }
        continue;
      }

      // 中文文本：生成 bigram（2字滑动窗口）
      const chars = [...seg]; // 正确处理 Unicode
      for (let i = 0; i <= chars.length - 2; i++) {
        const bigram = chars[i] + chars[i + 1];
        if (!stopWords.has(bigram) && !seen.has(bigram)) {
          seen.add(bigram);
          keywords.push(bigram);
        }
      }
    }

    return keywords.slice(0, 8);
  }
}
