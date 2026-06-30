// Process-based LLM adapter plus legacy semantic prompt schemas used by older routing paths.
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import type { MemoryApplicabilityAction, TaskStatus } from './types.js';
import type { NaturalLanguageRoute, NaturalLanguageRouteAction, TaskStateOwnershipResult, TaskStatusQueryScope } from './task-routing.js';
import { normalizeTaskRouteIntent } from './executor-router.js';
import type { ExecutorProfile, IntentDecision, IntentDecisionKind, IntentRouteAction, TaskRouteIntent } from './executor-router.js';
import { buildCodexNonInteractiveArgs } from '../executor/codex-args.js';

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

/**
 * @deprecated Legacy compatibility for the pre-IntentOrchestrator task-binding schema.
 * Natural-language main paths must consume IntentDecisionV2 via IntentOrchestrator.
 */
export interface IntentResult {
  type: 'new' | 'reference';
  taskId: string | null;
  reason: string;
}

/**
 * @deprecated Legacy compatibility for parked/blocked resume resolution.
 * Use TaskSemanticService only as an adapter boundary; session must not call this directly.
 */
export interface TaskResumeIntentResult {
  action: 'resume' | 'none';
  taskId: string | null;
  reason: string;
  confidence: number;
}

/**
 * @deprecated Legacy compatibility for route-compatible schemas.
 * Natural-language main paths must consume IntentDecisionV2 via IntentOrchestrator.
 */
export interface RouteResult {
  route: NaturalLanguageRouteAction;
  confidence: number;
  reason: string;
  statusScope?: TaskStatusQueryScope | null;
  taskId?: string | null;
  clarificationQuestion?: string | null;
}

/**
 * @deprecated Legacy compatibility for the pre-IntentOrchestrator route-compatible schema.
 * Natural-language main paths must consume IntentDecisionV2 via IntentOrchestrator.
 */
export type IntentDecisionResult = IntentDecision & {
  statusScope?: TaskStatusQueryScope | null;
  clarificationQuestion?: string | null;
};

export interface TaskPriorityResult {
  priority: 'normal' | 'high' | 'urgent';
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
      return buildCodexNonInteractiveArgs(prompt);
    }

    return [
      '--print',
      '--dangerously-skip-permissions',
      prompt,
    ];
  }

  /**
   * @deprecated Legacy compatibility for the pre-IntentOrchestrator task-binding schema.
   * Natural-language main paths must use IntentOrchestrator.decide().
   */
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

  /**
   * @deprecated Legacy compatibility for parked/blocked resume resolution.
   * Use TaskSemanticService only as an adapter boundary; session must not call this directly.
   */
  async resolveTaskResumeIntent(userInput: string, candidateTasks: TaskSummary[]): Promise<TaskResumeIntentResult> {
    const resumableTasks = candidateTasks.filter(task => task.status === 'parked' || task.status === 'blocked');
    if (resumableTasks.length === 0) {
      return { action: 'none', taskId: null, reason: '没有 blocked/parked 候选任务', confidence: 0 };
    }

    try {
      return this.normalizeTaskResumeIntentResult(
        this.parseTaskResumeIntentResult(await this.query(this.buildTaskResumeIntentPrompt(userInput, resumableTasks))),
        resumableTasks,
      );
    } catch {
      return { action: 'none', taskId: null, reason: 'LLM resume intent 调用失败，fallback', confidence: 0 };
    }
  }

  /**
   * @deprecated Legacy compatibility for route-compatible schemas.
   * Natural-language main paths must use IntentOrchestrator.decide().
   */
  async resolveRoute(userInput: string, recentTasks: TaskSummary[]): Promise<RouteResult> {
    try {
      const raw = await this.query(this.buildRoutePrompt(userInput, recentTasks));
      return this.parseRouteResult(raw);
    } catch {
      return { route: 'unknown', confidence: 0, reason: 'LLM route 调用失败，fallback' };
    }
  }

  /**
   * @deprecated Legacy compatibility for the pre-IntentOrchestrator route-compatible schema.
   * Natural-language main paths must use IntentOrchestrator.decide() and IntentDecisionV2.
   */
  async resolveIntentDecision(input: {
    userInput: string;
    currentFocus: string;
    recentTasks: TaskSummary[];
    profiles: ExecutorProfile[];
    defaultExecutorName: string;
    allowDurableTask: boolean;
    allowFileModification: boolean;
    historicalPreferenceSummary: string;
  }): Promise<IntentDecisionResult> {
    try {
      const raw = await this.query(this.buildIntentDecisionPrompt(input));
      return this.parseIntentDecisionResult(raw);
    } catch {
      return this.unknownIntentDecision(input.defaultExecutorName, 'LLM intent decision 调用失败');
    }
  }

  /**
   * @deprecated Legacy compatibility for task-status ownership checks.
   * Natural-language main paths must use IntentOrchestrator.decide().
   */
  async resolveTaskStateOwnership(
    userInput: string,
    recentTasks: TaskSummary[],
  ): Promise<TaskStateOwnershipResult> {
    try {
      const raw = await this.query(this.buildTaskStateOwnershipPrompt(userInput, recentTasks));
      return this.normalizeTaskStateOwnershipResult(
        this.parseTaskStateOwnershipResult(raw),
        recentTasks,
      );
    } catch {
      return {
        owner: 'none',
        scope: null,
        taskId: null,
        confidence: 0,
        reason: 'LLM task state ownership 调用失败，fallback',
      };
    }
  }

  async resolveTaskPriority(userInput: string): Promise<TaskPriorityResult> {
    try {
      const raw = await this.query(this.buildTaskPriorityPrompt(userInput));
      return this.parseTaskPriorityResult(raw);
    } catch {
      return this.fallbackTaskPriorityResult(userInput);
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

  private buildTaskResumeIntentPrompt(userInput: string, tasks: TaskSummary[]): string {
    const taskList = tasks.map(task =>
      `  ${task.id}: [${task.status}] ${task.title} / ${task.goal}${task.summary ? ` / 进度: ${task.summary.slice(0, 80)}` : ''}`
    ).join('\n');

    return [
      '判断用户输入是否是在要求恢复、重启、继续执行下面某个已经 blocked 或 parked 的任务。',
      '这是语义判断，不要只看关键词；要理解用户真实意图。',
      '只有当用户明显是在操作已有任务，而不是提出一个全新工作目标时，才返回 action=resume。',
      '如果用户指定了 task id，且该 id 在候选列表中，通常应选择该任务。',
      '如果用户只是提出新的调研/分析/实现需求，即使文字里出现“任务”，也返回 action=none。',
      '如果多个候选都可能匹配，选择语义最贴近用户输入、状态为 blocked/parked、最近上下文最连续的那个。',
      '只返回 JSON，不要其他内容。',
      '',
      `用户输入：${userInput}`,
      '',
      '候选 blocked/parked 任务：',
      taskList,
      '',
      '返回格式：{"action":"resume"|"none","taskId":"task_xxx"|null,"confidence":0到1,"reason":"简短原因"}',
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
      '你是 MetaClaw 自然语言入口的唯一语义路由器。后续模块只消费你的结构化裁决。',
      '判断这条输入应该走哪条路由。禁止依赖关键词硬规则，必须做语义判断。',
      '可选 route：conversation、metaclaw_status、task_control、durable_task、ask_clarification。',
      'conversation: 问候、闲聊、短确认、回忆对话、身份设定等，不应创建任务。',
      'metaclaw_status: 用户在问 MetaClaw 任务池/调度/队列/运行中/阻塞/挂起/任务卡在哪/是否完成等状态，应由 MetaClaw 根据任务数据库回答。',
      'task_control: 明确针对已有任务的控制，例如恢复挂起任务、暂停当前任务、解除阻塞、重试刚才那个任务；必须有清晰的任务对象。',
      '如果输入只是“继续”“展开”“细讲”“再说说”，优先视为 conversation，而不是 task_control。',
      'durable_task: 有明确目标或交付物，需要持续管理、排队、挂起、阻塞、恢复的工作。',
      '如果用户明确说“不要改代码、只分析、read-only”，不得路由为需要 repo mutation 的执行工作；可按 durable_task 或 conversation 由下游选择只读执行。',
      '如果语义低置信、任务对象不清、无法判断是聊天还是恢复任务，返回 ask_clarification，不要默认创建任务或恢复旧任务。',
      '只有 /task xxx、/resume task_xxx 这种显式命令允许确定性命令路由；自然语言必须由本裁决决定。',
      '只返回 JSON，不要其他内容。',
      '',
      `用户输入：${userInput}`,
      '',
      '当前任务概览：',
      taskList,
      '',
      '返回格式：{"route":"conversation"|"metaclaw_status"|"task_control"|"durable_task"|"ask_clarification","confidence":0到1,"statusScope":"running|blocked|dashboard|null","taskId":"task_xxx|null","clarificationQuestion":"需要追问时的问题或 null","reason":"简短原因"}',
    ].join('\n');
  }

  private buildIntentDecisionPrompt(input: {
    userInput: string;
    currentFocus: string;
    recentTasks: TaskSummary[];
    profiles: ExecutorProfile[];
    defaultExecutorName: string;
    allowDurableTask: boolean;
    allowFileModification: boolean;
    historicalPreferenceSummary: string;
  }): string {
    const taskList = input.recentTasks.length === 0
      ? '  （当前没有可管理任务）'
      : input.recentTasks.map(task =>
        `  ${task.id}: [${task.status}] ${task.title} / goal=${task.goal}${task.summary ? ` / summary=${task.summary.slice(0, 80)}` : ''}`
      ).join('\n');
    const profileList = input.profiles.length === 0
      ? '  （无 executor profile）'
      : input.profiles.map(profile => [
        `  ${profile.name}:`,
        `    capabilities=${profile.capabilities.join(',') || '-'}`,
        `    strengths=${profile.strengths.join(',') || '-'}`,
        `    avoid=${profile.avoidUseCases?.join(',') || '-'}`,
        `    risk=${profile.riskLevel}`,
        `    availability=${profile.availability}`,
      ].join('\n')).join('\n');

    return [
      '你是 MetaClaw 的 IntentDecision 语义裁决器。',
      '不要做关键词匹配。必须基于用户目标、上下文、交付物、任务状态、执行风险做语义判断。',
      '只能返回 JSON，且必须符合 IntentDecision schema；不要输出解释性文字。',
      '',
      '判断维度：',
      '1. 用户是在闲聊/直接问答，还是要一个可交付结果？',
      '2. 是否在控制已有任务，比如恢复、暂停、查询任务状态？',
      '3. 是否需要创建 durable task？',
      '4. 是否需要本地 repo 执行？',
      '5. 是否需要研究/多工具/长期记忆/外部消息网关？',
      '6. 是否存在歧义，需要先问用户？',
      '7. 选择哪个 target 和 action，为什么？',
      '',
      '路由语义：',
      'direct_reply：普通问答、解释、设计方案、短确认。不创建任务，不派发 executor，当前会话直接回复。',
      'task_control：查询任务状态、恢复挂起任务、取消任务、暂停任务。目标必须是 metaclaw。',
      'durable_task：有明确交付物、耗时、可中断、需要产物记录的任务。先创建/绑定任务，再派发 executor。',
      'executor_dispatch：可以直接执行的一次性工作，比如本地代码修改、运行测试、代码审查、调研执行。是否包装成 durable task 由 needsLongRunningTask 决定。',
      'clarification：语义不清或低置信度，比如“继续弄一下”但无法确定是继续对话、恢复任务，还是创建跟进任务。',
      '',
      'Executor 选择逻辑：',
      '如果应交给 executor，route.target 必须优先选择可用 profiles 中最合适的 name。',
      '如果是任务状态/任务控制，route.target 必须是 metaclaw。',
      '如果需要本地 repo 修改或测试，通常选择 repo_execution 能力 executor；如果用户不允许改文件，canModifyFiles=false。',
      '如果需要调研、多工具、长期记忆或外部消息网关，选择对应 profile，不要默认给 repo executor。',
      'route.capabilityClass 必须使用新的 CapabilityClass 单类输出：code_edit / research / messaging / memory_ops / office_automation / conversation / general。',
      'CapabilityClass 按工具/副作用边界判断，不按模型推理能力判断；不要产出 reasoning 类。',
      '',
      `用户原话：${input.userInput}`,
      `当前会话焦点：${input.currentFocus}`,
      `当前默认 executor：${input.defaultExecutorName}`,
      `是否允许创建 durable task：${input.allowDurableTask}`,
      `是否允许修改文件：${input.allowFileModification}`,
      `历史偏好摘要：${input.historicalPreferenceSummary || '（无）'}`,
      '',
      '最近任务列表：',
      taskList,
      '',
      '可用 executor profile：',
      profileList,
      '',
      'JSON schema：',
      JSON.stringify({
        intent: 'direct_reply|task_control|durable_task|executor_dispatch|clarification',
        confidence: '0..1',
        needsClarification: 'boolean',
        needsLongRunningTask: 'boolean',
        requiresLocalRepo: 'boolean',
        requiresResearch: 'boolean',
        requiresMultiTool: 'boolean',
        requiresLongTermMemory: 'boolean',
        requiresExternalGateway: 'boolean',
        canModifyFiles: 'boolean',
        shouldCreateDurableTask: 'boolean',
        statusScope: 'running|blocked|dashboard|null',
        clarificationQuestion: 'string|null',
        reason: 'string',
        route: {
          target: 'metaclaw|executor profile name',
          action: 'none|auto_dispatch|ask_review|fallback_default|ask_clarification',
          primaryIntent: 'repo_execution|technical_reasoning|research_workflow|memory_agent_ops|conversation_or_control|general',
          capabilityClass: 'code_edit|research|messaging|memory_ops|office_automation|conversation|general',
          requiredCapabilities: ['capability names'],
          matchedBoundary: ['semantic boundary labels'],
          riskLevel: 'low|medium|high',
          taskId: 'task_xxx|null',
        },
      }),
    ].join('\n');
  }

  private buildTaskStateOwnershipPrompt(userInput: string, tasks: TaskSummary[]): string {
    const taskList = tasks.length === 0
      ? '  （当前没有历史任务）'
      : tasks.map(task =>
        `  ${task.id}: [${task.status}] ${task.title} / ${task.goal}${task.summary ? ` / 摘要: ${task.summary.slice(0, 80)}` : ''}`
      ).join('\n');

    return [
      '判断用户这句话问的是 MetaClaw 的任务池/调度状态，还是要交给 Executor 执行具体工作。',
      '必须做语义判断，不要只看关键词。',
      '',
      'owner=metaclaw：用户在问 MetaClaw 自己维护的任务状态、任务池、调度、队列、阻塞、挂起、运行中、是否完成、为什么没收到结果、任务卡在哪里、当前有什么任务。',
      '这些状态只能由 MetaClaw 根据任务数据库/调度器回答，不能交给 Executor 猜。',
      '',
      'owner=executor：用户要检查、分析、改写、继续生成实际交付内容，或要求查看文件/代码/报告/产物是否正确、完整、能否运行。',
      '这些需要 Executor 使用工具或围绕交付物内容工作，即使文字里出现“任务、结果、完成、检查”。',
      '',
      'owner=none：普通闲聊、偏好设置、记忆、或无法判断为任务状态/执行工作的输入。',
      '',
      'scope 只在 owner=metaclaw 时填写：',
      'running：问当前是否在执行、刚才/这个任务是否完成、为什么没收到结果、卡在哪里。',
      'blocked：问阻塞任务、被卡住且缺什么条件/材料。',
      'dashboard：问任务池总览、有哪些任务、队列/挂起/待执行/所有任务状态。',
      '',
      '如果用户语义是在问 MetaClaw 的调度事实，优先 owner=metaclaw；不要因为句子里没有固定关键词而返回 executor。',
      '如果用户明确要“检查某个文件/生成内容/报告/代码是否完整或正确”，返回 owner=executor。',
      '只返回 JSON，不要其他内容。',
      '',
      `用户输入：${userInput}`,
      '',
      '最近任务：',
      taskList,
      '',
      '返回格式：{"owner":"metaclaw"|"executor"|"none","scope":"running"|"blocked"|"dashboard"|null,"taskId":"task_xxx"|null,"confidence":0到1,"reason":"简短语义依据"}',
    ].join('\n');
  }

  private buildTaskPriorityPrompt(userInput: string): string {
    return [
      '判断这个任务的调度优先级。必须做语义判断，不要只看关键词。',
      'urgent: 用户语义上是在插队、临时紧急处理、要求打断当前队列、马上/立即处理，或任务本身有明显时间压力。',
      'high: 比普通任务更重要或更希望优先，但不一定要插队打断。',
      'normal: 顺序执行即可，没有紧急或优先语义。',
      '只返回 JSON，不要其他内容。',
      '',
      `用户输入：${userInput}`,
      '',
      '返回格式：{"priority":"normal"|"high"|"urgent","reason":"简短语义依据"}',
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
      'ask_review: 中等相关、不确定、可能改变执行路径或存在高影响；系统会默认跳过，不会询问用户确认。',
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

  private parseTaskResumeIntentResult(raw: string): TaskResumeIntentResult {
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const confidence = typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;
      if (parsed.action === 'resume') {
        return {
          action: 'resume',
          taskId: typeof parsed.taskId === 'string' ? parsed.taskId : null,
          reason: typeof parsed.reason === 'string' ? parsed.reason : 'LLM 语义判断恢复已有任务',
          confidence,
        };
      }
      if (parsed.action === 'none') {
        return {
          action: 'none',
          taskId: null,
          reason: typeof parsed.reason === 'string' ? parsed.reason : 'LLM 语义判断不是恢复任务',
          confidence,
        };
      }
    } catch {}

    return { action: 'none', taskId: null, reason: 'resume intent 解析失败，fallback', confidence: 0 };
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
      if (
        parsed.route === 'conversation'
        || parsed.route === 'metaclaw_status'
        || parsed.route === 'task_control'
        || parsed.route === 'durable_task'
        || parsed.route === 'ask_clarification'
      ) {
        return {
          route: parsed.route,
          confidence: typeof parsed.confidence === 'number'
            ? Math.max(0, Math.min(1, parsed.confidence))
            : 0.5,
          reason: typeof parsed.reason === 'string' ? parsed.reason : '',
          statusScope: this.parseTaskStatusQueryScope(parsed.statusScope),
          taskId: typeof parsed.taskId === 'string' ? parsed.taskId : null,
          clarificationQuestion: typeof parsed.clarificationQuestion === 'string' ? parsed.clarificationQuestion : null,
        };
      }
    } catch {}

    return { route: 'unknown', confidence: 0, reason: 'route 解析失败，fallback' };
  }

  private parseIntentDecisionResult(raw: string): IntentDecisionResult {
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const route = parsed.route && typeof parsed.route === 'object' ? parsed.route : {};

      return {
        intent: this.parseIntentDecisionKind(parsed.intent),
        confidence: this.clampConfidence(parsed.confidence),
        needsClarification: parsed.needsClarification === true,
        needsLongRunningTask: parsed.needsLongRunningTask === true,
        requiresLocalRepo: parsed.requiresLocalRepo === true,
        requiresResearch: parsed.requiresResearch === true,
        requiresMultiTool: parsed.requiresMultiTool === true,
        requiresLongTermMemory: parsed.requiresLongTermMemory === true,
        requiresExternalGateway: parsed.requiresExternalGateway === true,
        canModifyFiles: parsed.canModifyFiles === true,
        shouldCreateDurableTask: parsed.shouldCreateDurableTask === true,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'LLM intent decision',
        statusScope: this.parseTaskStatusQueryScope(parsed.statusScope),
        clarificationQuestion: typeof parsed.clarificationQuestion === 'string' ? parsed.clarificationQuestion : null,
        route: {
          target: typeof route.target === 'string' ? route.target : 'metaclaw',
          action: this.parseIntentRouteAction(route.action),
          primaryIntent: this.parseTaskRouteIntent(route.primaryIntent),
          routeIntent: this.parseTaskRouteIntent(route.capabilityClass),
          requiredCapabilities: Array.isArray(route.requiredCapabilities)
            ? route.requiredCapabilities.filter((item: unknown): item is string => typeof item === 'string')
            : [],
          matchedBoundary: Array.isArray(route.matchedBoundary)
            ? route.matchedBoundary.filter((item: unknown): item is string => typeof item === 'string')
            : [],
          riskLevel: this.parseExecutorRiskLevel(route.riskLevel),
          taskId: typeof route.taskId === 'string' ? route.taskId : null,
        },
      };
    } catch {}

    return this.unknownIntentDecision('metaclaw', 'intent decision 解析失败，fallback');
  }

  private unknownIntentDecision(defaultExecutorName: string, reason: string): IntentDecisionResult {
    return {
      intent: 'clarification',
      confidence: 0,
      needsClarification: true,
      needsLongRunningTask: false,
      requiresLocalRepo: false,
      requiresResearch: false,
      requiresMultiTool: false,
      requiresLongTermMemory: false,
      requiresExternalGateway: false,
      canModifyFiles: false,
      shouldCreateDurableTask: false,
      reason,
      statusScope: null,
      clarificationQuestion: '我不确定你是想继续聊天、创建新任务，还是控制已有任务。请再明确一下。',
      route: {
        target: defaultExecutorName === 'metaclaw' ? 'metaclaw' : defaultExecutorName,
        action: 'ask_clarification',
        primaryIntent: 'conversation_or_control',
        routeIntent: 'conversation_or_control',
        requiredCapabilities: [],
        matchedBoundary: [],
        riskLevel: 'low',
        taskId: null,
      },
    };
  }

  private parseIntentDecisionKind(value: unknown): IntentDecisionKind {
    return value === 'direct_reply'
      || value === 'task_control'
      || value === 'durable_task'
      || value === 'executor_dispatch'
      || value === 'clarification'
      ? value
      : 'clarification';
  }

  private parseIntentRouteAction(value: unknown): IntentRouteAction {
    return value === 'none'
      || value === 'auto_dispatch'
      || value === 'ask_review'
      || value === 'fallback_default'
      || value === 'ask_clarification'
      ? value
      : 'ask_clarification';
  }

  private parseTaskRouteIntent(value: unknown): TaskRouteIntent {
    return normalizeTaskRouteIntent(value);
  }

  private parseExecutorRiskLevel(value: unknown): 'low' | 'medium' | 'high' {
    return value === 'low' || value === 'medium' || value === 'high' ? value : 'medium';
  }

  private clampConfidence(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.min(1, value))
      : 0;
  }

  private parseTaskStateOwnershipResult(raw: string): TaskStateOwnershipResult {
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const owner = parsed.owner === 'metaclaw' || parsed.owner === 'executor' || parsed.owner === 'none'
        ? parsed.owner
        : 'none';
      const scope = this.parseTaskStatusQueryScope(parsed.scope);
      const confidence = typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;

      return {
        owner,
        scope: owner === 'metaclaw' ? scope : null,
        taskId: typeof parsed.taskId === 'string' ? parsed.taskId : null,
        confidence,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'LLM 语义判断任务状态归属',
      };
    } catch {}

    return {
      owner: 'none',
      scope: null,
      taskId: null,
      confidence: 0,
      reason: 'task state ownership 解析失败，fallback',
    };
  }

  private parseTaskStatusQueryScope(value: unknown): TaskStatusQueryScope | null {
    return value === 'blocked' || value === 'running' || value === 'dashboard'
      ? value
      : null;
  }

  private parseTaskPriorityResult(raw: string): TaskPriorityResult {
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed.priority === 'normal' || parsed.priority === 'high' || parsed.priority === 'urgent') {
        return {
          priority: parsed.priority,
          reason: typeof parsed.reason === 'string' ? parsed.reason : 'LLM 语义优先级判断',
        };
      }
    } catch {}

    return { priority: 'normal', reason: 'priority 解析失败，fallback normal' };
  }

  private fallbackTaskPriorityResult(userInput: string): TaskPriorityResult {
    if (/紧急|急|插入|插队|优先|马上|立刻|立即|urgent|asap/i.test(userInput)) {
      return { priority: 'urgent', reason: 'LLM 不可用，规则兜底识别到紧急/插队表达' };
    }
    return { priority: 'normal', reason: 'LLM 不可用，未识别到明确优先级信号' };
  }

  private normalizeIntentResult(result: IntentResult, candidates: TaskSummary[]): IntentResult {
    if (result.type !== 'reference') {
      return result;
    }

    return candidates.some(task => task.id === result.taskId)
      ? result
      : { type: 'new', taskId: null, reason: 'LLM 返回了无效任务 ID，fallback' };
  }

  private normalizeTaskResumeIntentResult(
    result: TaskResumeIntentResult,
    candidates: TaskSummary[],
  ): TaskResumeIntentResult {
    if (result.action !== 'resume' || !result.taskId) {
      return { ...result, action: 'none', taskId: null };
    }

    return candidates.some(task => task.id === result.taskId)
      ? result
      : { action: 'none', taskId: null, reason: 'LLM 返回了无效恢复任务 ID，fallback', confidence: 0 };
  }

  private normalizeTaskStateOwnershipResult(
    result: TaskStateOwnershipResult,
    candidates: TaskSummary[],
  ): TaskStateOwnershipResult {
    const taskId = result.taskId && candidates.some(task => task.id === result.taskId)
      ? result.taskId
      : null;

    if (result.owner !== 'metaclaw') {
      return { ...result, scope: null, taskId };
    }

    return {
      ...result,
      scope: result.scope ?? 'dashboard',
      taskId,
    };
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
