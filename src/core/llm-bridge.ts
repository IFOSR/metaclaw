import { spawn } from 'child_process';
import { tmpdir } from 'os';

export interface TaskSummary {
  id: string;
  title: string;
  goal: string;
  summary: string;
}

export interface InteractionSummary {
  id: string;
  userInput: string;
}

export interface IntentResult {
  type: 'new' | 'reference';
  taskId: string | null;
  reason: string;
}

const LLM_TIMEOUT = 30_000;

export class LlmBridge {
  constructor(private command: string) {}

  async query(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.command, this.buildCommandArgs(prompt), {
        cwd: tmpdir(),
        timeout: LLM_TIMEOUT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`LLM exited with code ${code}`));
      });
      proc.on('error', reject);
    });
  }

  private buildCommandArgs(prompt: string): string[] {
    if (this.command === 'codex') {
      return [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        prompt,
      ];
    }

    return [
      '--print',
      '--dangerously-skip-permissions',
      prompt,
    ];
  }

  async resolveIntent(userInput: string, recentTasks: TaskSummary[]): Promise<IntentResult> {
    if (recentTasks.length === 0) {
      return { type: 'new', taskId: null, reason: '无历史任务' };
    }

    try {
      const prompt = this.buildIntentPrompt(userInput, recentTasks);
      const raw = await this.query(prompt);
      return this.parseIntentResult(raw);
    } catch {
      return { type: 'new', taskId: null, reason: 'LLM 调用失败，fallback' };
    }
  }

  async rankInteractions(userInput: string, candidates: InteractionSummary[]): Promise<string[]> {
    if (candidates.length === 0) return [];

    try {
      const prompt = this.buildRankPrompt(userInput, candidates);
      const raw = await this.query(prompt);
      return this.parseRankResult(raw);
    } catch {
      return [];
    }
  }

  private buildIntentPrompt(userInput: string, tasks: TaskSummary[]): string {
    const taskList = tasks.map(t =>
      `  ${t.id}: ${t.title} / ${t.goal}${t.summary ? ` / 进度: ${t.summary.slice(0, 50)}` : ''}`
    ).join('\n');

    return [
      '判断用户输入是一个全新任务，还是在引用之前的某个任务。',
      '只返回 JSON，不要其他内容。',
      '',
      `用户输入：${userInput}`,
      '',
      '最近的任务列表：',
      taskList,
      '',
      '返回格式：{"type":"new"|"reference","taskId":"task_xxx"|null,"reason":"简短原因"}',
    ].join('\n');
  }

  private buildRankPrompt(userInput: string, candidates: InteractionSummary[]): string {
    const list = candidates.map(c =>
      `  ${c.id}: ${c.userInput.slice(0, 50)}`
    ).join('\n');

    return [
      '从以下历史交互中，选出与用户当前输入最相关的条目。',
      '只返回相关条目的 ID 数组（JSON），最多 5 个。如果都不相关，返回空数组 []。',
      '',
      `用户输入：${userInput}`,
      '',
      '历史交互：',
      list,
      '',
      '返回格式：["id_1", "id_2"]',
    ].join('\n');
  }

  private parseIntentResult(raw: string): IntentResult {
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed.type === 'reference' || parsed.type === 'new') {
        return {
          type: parsed.type,
          taskId: parsed.taskId ?? null,
          reason: parsed.reason ?? '',
        };
      }
    } catch {}
    return { type: 'new', taskId: null, reason: '解析失败，fallback' };
  }

  private parseRankResult(raw: string): string[] {
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) return parsed.filter(id => typeof id === 'string');
    } catch {}
    return [];
  }
}
