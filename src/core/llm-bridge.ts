import { spawn } from 'child_process';
import { tmpdir } from 'os';
import type { MemoryApplicabilityAction, TaskStatus } from './types.js';
import type { NaturalLanguageRoute } from './task-routing.js';

export interface TaskSummary {
  id: string;
  title: string;
  goal: string;
  summary: string;
  status: TaskStatus;
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

export interface RouteResult {
  route: NaturalLanguageRoute | 'unknown';
  reason: string;
}

export interface PreferenceRecallSummary {
  id: string;
  scope: string;
  subject: string | null;
  type: string;
  content: string;
}

export interface PreferenceRecallDecision {
  preferenceId: string;
  reason: string;
  score?: number;
  action?: MemoryApplicabilityAction;
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
      const primary = this.normalizeIntentResult(
        this.parseIntentResult(await this.query(this.buildIntentPrompt(userInput, recentTasks))),
        recentTasks,
      );

      if (!this.shouldRetryWithParkedTasks(userInput, recentTasks, primary)) {
        return primary;
      }

      const parkedTasks = recentTasks.filter(task => task.status === 'parked');
      const parkedResult = this.normalizeIntentResult(
        this.parseIntentResult(await this.query(this.buildParkedIntentPrompt(userInput, parkedTasks))),
        parkedTasks,
      );

      if (parkedResult.type === 'reference') {
        return parkedResult;
      }

      return primary;
    } catch {
      return { type: 'new', taskId: null, reason: 'LLM 调用失败，fallback' };
    }
  }

  async resolveRoute(userInput: string, recentTasks: TaskSummary[]): Promise<RouteResult> {
    try {
      const raw = await this.query(this.buildRoutePrompt(userInput, recentTasks));
      return this.parseRouteResult(raw);
    } catch {
      return { route: 'unknown', reason: 'LLM route 调用失败，fallback' };
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

  async recallPreferences(
    userInput: string,
    candidates: PreferenceRecallSummary[],
  ): Promise<PreferenceRecallDecision[]> {
    if (candidates.length === 0) return [];

    try {
      const prompt = this.buildPreferenceRecallPrompt(userInput, candidates);
      const raw = await this.query(prompt);
      return this.parsePreferenceRecallResult(raw, new Set(candidates.map(candidate => candidate.id)));
    } catch {
      throw new Error('LLM preference recall 调用失败');
    }
  }

  private buildIntentPrompt(userInput: string, tasks: TaskSummary[]): string {
    const taskList = tasks.map(t =>
      `  ${t.id}: [${t.status}] ${t.title} / ${t.goal}${t.summary ? ` / 进度: ${t.summary.slice(0, 50)}` : ''}`
    ).join('\n');

    return [
      '判断用户输入是一个全新任务，还是在引用之前的某个任务。',
      '任务状态很重要，尤其要注意 created / ready / running / parked / blocked / done 的区别。',
      '只有当用户明确提到“挂起的任务”“恢复任务”“继续刚才那个任务”“解除阻塞”这类任务对象时，才优先判断是不是在引用已有任务。',
      '如果用户只是说“继续”“展开”“细讲”“再说说”，通常是在延续当前对话或刚刚的话题，不要直接绑定旧 parked 任务。',
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

  private buildParkedIntentPrompt(userInput: string, parkedTasks: TaskSummary[]): string {
    const taskList = parkedTasks.map(task =>
      `  ${task.id}: [parked] ${task.title} / ${task.goal}${task.summary ? ` / 进度: ${task.summary.slice(0, 50)}` : ''}`
    ).join('\n');

    return [
      '用户这次很可能是在要求“恢复之前挂起的任务”。',
      '请只在下面这些 parked 任务中判断是否存在被引用的目标。',
      '如果能明确对应某个 parked 任务，返回 reference。',
      '如果完全对应不上，再返回 new。',
      '只返回 JSON，不要其他内容。',
      '',
      `用户输入：${userInput}`,
      '',
      '当前挂起任务：',
      taskList,
      '',
      '返回格式：{"type":"new"|"reference","taskId":"task_xxx"|null,"reason":"简短原因"}',
    ].join('\n');
  }

  private buildRoutePrompt(userInput: string, tasks: TaskSummary[]): string {
    const taskList = tasks.length === 0
      ? '  （当前没有可管理任务）'
      : tasks.map(task =>
        `  ${task.id}: [${task.status}] ${task.title} / ${task.goal}${task.summary ? ` / 进度: ${task.summary.slice(0, 50)}` : ''}`
      ).join('\n');

    return [
      '判断这条输入应该走哪条路由。',
      '可选路由只有三种：conversation、task_control、durable_task。',
      'conversation: 问候、闲聊、短确认、回忆对话、身份设定等，不应创建任务。',
      'task_control: 明确针对已有任务的控制，例如恢复挂起任务、暂停当前任务、解除阻塞、重试刚才那个任务；必须有清晰的任务对象。',
      '如果输入只是“继续”“展开”“细讲”“再说说”，优先视为 conversation，而不是 task_control。',
      'durable_task: 有明确目标或交付物，需要持续管理、排队、挂起、阻塞、恢复的工作。',
      '只返回 JSON，不要其他内容。',
      '',
      `用户输入：${userInput}`,
      '',
      '当前任务概览：',
      taskList,
      '',
      '返回格式：{"route":"conversation"|"task_control"|"durable_task","reason":"简短原因"}',
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

  private buildPreferenceRecallPrompt(
    userInput: string,
    candidates: PreferenceRecallSummary[],
  ): string {
    const list = candidates.map(candidate => [
      `  ${candidate.id}:`,
      `    scope=${candidate.scope}`,
      `    subject=${candidate.subject ?? 'null'}`,
      `    type=${candidate.type}`,
      `    content=${candidate.content}`,
    ].join('\n')).join('\n');

    return [
      '判断用户当前输入是否需要召回下面的用户偏好/记忆。',
      '这是产品体验关键路径：必须理解用户意图和偏好的适用边界，不要做关键词匹配。',
      '请对每条候选做三态裁决：auto_apply / ask_review / suppress。',
      'auto_apply: 明确相关、低风险、没有当前指令冲突，可静默采用。',
      'ask_review: 中等相关、不确定、可能改变执行路径或存在高影响，需要用户确认。',
      'suppress: 只有关键词相同、泛词命中、元讨论、纠错/否认、无关场景，静默忽略。',
      '只有当偏好对当前请求的执行方式、输出格式、对象关系或上下文选择有明确帮助时才 auto_apply 或 ask_review。',
      '不要因为共享“内容、分析、相关、报告、图片、文档”等泛词就召回。',
      '如果用户当前输入是在否认、纠错、询问系统行为，通常不要召回交付物偏好。',
      'task-local 且属于当前任务的偏好通常可以召回；project/contact/global 需要语义相关。',
      '只返回 JSON 数组，不要其他内容。每项必须包含 preferenceId、action、reason、score。',
      '',
      `用户输入：${userInput}`,
      '',
      '候选偏好：',
      list,
      '',
      '返回格式：[{"preferenceId":"pref_xxx","action":"auto_apply|ask_review|suppress","reason":"为什么这样裁决","score":0.0到1.0}]',
      '如果都完全不适用，可以返回 suppress 项，也可以返回 []。',
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

  private parsePreferenceRecallResult(raw: string, validIds: Set<string>): PreferenceRecallDecision[] {
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .map((item): PreferenceRecallDecision | null => {
          const preferenceId = typeof item?.preferenceId === 'string'
            ? item.preferenceId
            : typeof item?.id === 'string'
              ? item.id
              : null;
          if (!preferenceId || !validIds.has(preferenceId)) {
            return null;
          }

          const rawScore = typeof item?.score === 'number' ? item.score : undefined;
          const score = rawScore === undefined
            ? undefined
            : Math.max(0, Math.min(1, rawScore));

          return {
            preferenceId,
            reason: typeof item?.reason === 'string' && item.reason.trim()
              ? item.reason.trim()
              : 'executor 判定当前偏好适用',
            score,
            action: this.parsePreferenceRecallAction(item?.action),
          };
        })
        .filter((item): item is PreferenceRecallDecision => Boolean(item));
    } catch {}

    return [];
  }

  private parsePreferenceRecallAction(value: unknown): MemoryApplicabilityAction | undefined {
    return value === 'auto_apply' || value === 'ask_review' || value === 'suppress'
      ? value
      : undefined;
  }

  private parseRouteResult(raw: string): RouteResult {
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed.route === 'conversation' || parsed.route === 'task_control' || parsed.route === 'durable_task') {
        return {
          route: parsed.route,
          reason: parsed.reason ?? '',
        };
      }
    } catch {}

    return { route: 'unknown', reason: 'route 解析失败，fallback' };
  }

  private normalizeIntentResult(result: IntentResult, candidates: TaskSummary[]): IntentResult {
    if (result.type !== 'reference') {
      return result;
    }

    return candidates.some(task => task.id === result.taskId)
      ? result
      : { type: 'new', taskId: null, reason: 'LLM 返回了无效任务 ID，fallback' };
  }

  private shouldRetryWithParkedTasks(
    userInput: string,
    recentTasks: TaskSummary[],
    primary: IntentResult,
  ): boolean {
    const parkedTasks = recentTasks.filter(task => task.status === 'parked');
    if (parkedTasks.length === 0 || !this.isExplicitParkedResumeRequest(userInput)) {
      return false;
    }

    return primary.type !== 'reference' || !parkedTasks.some(task => task.id === primary.taskId);
  }

  private isExplicitParkedResumeRequest(userInput: string): boolean {
    return /挂起|恢复|继续之前|继续.*挂起|继续.*任务/.test(userInput);
  }
}
