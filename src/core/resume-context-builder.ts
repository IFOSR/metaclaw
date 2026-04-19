import type { ContextRecaller } from './context-recaller.js';
import type { MemoryEngine } from './memory-engine.js';
import type { TaskEngine } from './task-engine.js';
import type { ExecutionContextBundle, ResolvedPreference, WorkspaceContext } from './types.js';
import { buildMaterialSummary, extractMaterialTextSnippets } from './material-utils.js';
import { resolve } from 'path';

interface BuildContextInput {
  taskId: string;
  mode: 'fresh' | 'resume-parked' | 'resume-blocked' | 'follow-up';
  userInput: string;
  sessionId: string;
  schedulingReason?: string;
  newlyProvidedResources?: string[];
}

export class ResumeContextBuilder {
  constructor(
    private taskEngine: TaskEngine,
    private memoryEngine: MemoryEngine,
    private contextRecaller: ContextRecaller,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async build(input: BuildContextInput): Promise<ExecutionContextBundle> {
    const task = this.taskEngine['taskRepo'].findById(input.taskId);
    if (!task) {
      throw new Error(`任务不存在: ${input.taskId}`);
    }

    const conversationHistory = await this.contextRecaller.recallAsync({
      taskId: task.id,
      sessionId: input.sessionId,
      userInput: input.userInput,
    });
    const latestSnapshot = this.taskEngine.getLatestSnapshot(task.id);
    const keywords = this.extractKeywords(input.userInput);
    const resolvedPreferences = this.memoryEngine.recall({
      taskId: task.id,
      keywords,
      userInput: input.userInput,
    }).map<ResolvedPreference>((preference) => ({
      id: preference.id,
      content: preference.content,
      scope: preference.scope,
      confidence: preference.confidence,
      reason: preference.scope === 'task-local' && (
        preference.subject === task.id || preference.sourceTasks.includes(task.id)
      )
        ? '命中当前任务局部偏好'
        : preference.sourceTasks.includes(task.id)
        ? '当前任务历史中已使用'
        : preference.subject
          ? `命中主体：${preference.subject}`
          : '命中当前输入关键词',
    }));

    const resources = Array.from(new Set([
      ...task.resources,
      ...(input.newlyProvidedResources ?? []),
    ]));
    const textSnippets = await extractMaterialTextSnippets(resources, {
      fetchImpl: this.fetchImpl,
    });
    const materialSummary = buildMaterialSummary(resources, textSnippets);

    const blockedReason = task.dependencies.find(dependency => dependency.status === 'waiting')?.description
      ?? task.dependencies[task.dependencies.length - 1]?.description;
    const workspaceContext = this.buildWorkspaceContext(input.userInput);
    const executionInstructions = this.buildExecutionInstructions(
      input.mode,
      input.newlyProvidedResources,
      workspaceContext,
      textSnippets.length > 0,
    );

    return {
      mode: input.mode,
      taskBrief: {
        id: task.id,
        title: task.title,
        goal: task.goal,
        status: task.status,
        summary: task.summary,
      },
      resumeContext: input.mode === 'fresh'
        ? undefined
        : {
            taskTitle: task.title,
            lastProgress: latestSnapshot?.done.join('；') || task.summary || '尚未开始',
            completedItems: latestSnapshot?.done ?? [],
            pendingItems: latestSnapshot?.pending ?? [],
            pauseReason: latestSnapshot?.pauseReason || task.lastInterruptionReason || '未知',
            interruptionReason: task.lastInterruptionReason || undefined,
            blockedReason,
            nextStep: latestSnapshot?.nextStep || '继续推进当前任务',
            schedulingReason: input.schedulingReason,
          },
      memoryContext: {
        explicitUserInstruction: input.userInput,
        resolvedPreferences,
      },
      historyContext: {
        taskTurns: conversationHistory.filter(turn => turn.source === 'task'),
        sessionTurns: conversationHistory.filter(turn => turn.source === 'session'),
        relatedTurns: conversationHistory.filter(turn => turn.source === 'keyword' || turn.source === 'llm'),
      },
      materialContext: {
        resources,
        textSnippets,
        summary: materialSummary,
      },
      workspaceContext,
      executionInstructions,
    };
  }

  private buildExecutionInstructions(
    mode: BuildContextInput['mode'],
    newlyProvidedResources?: string[],
    workspaceContext?: WorkspaceContext,
    hasMaterialText = false,
  ): string[] {
    const baseInstructions = [
      '使用与用户相同的语言回复',
      ...(hasMaterialText ? ['优先基于已注入的材料摘录作答，不要忽略其中已提供的事实'] : []),
    ];

    const fileInstructions = workspaceContext?.allowFilesystem
      ? [
          '必须把结果写入本地文件系统，不要只在回复中描述结果',
          `工作目录：${workspaceContext.workingDirectory}`,
          ...workspaceContext.targetPaths.map(path => `目标目录：${path}`),
          '如果目标目录不存在，请先创建目录，再写入一个合适命名的 Markdown 文件',
          '完成后明确返回保存路径和文件名，优先返回绝对路径',
        ]
      : [];

    if (mode === 'fresh') {
      return [
        ...baseInstructions,
        ...fileInstructions,
      ];
    }

    if (mode === 'resume-blocked') {
      return [
        ...baseInstructions,
        ...fileInstructions,
        '这是恢复执行，不要从头重做',
        '优先从上次未完成步骤继续',
        newlyProvidedResources && newlyProvidedResources.length > 0
          ? '先检查新增材料是否足以推进任务'
          : '先确认阻塞条件是否已经解除',
      ];
    }

    return [
      ...baseInstructions,
      ...fileInstructions,
      '这是恢复执行，不要从头重做',
      '优先从上次未完成步骤继续',
    ];
  }

  private buildWorkspaceContext(userInput: string): WorkspaceContext | undefined {
    if (!/(存档|归档|保存|写入)/.test(userInput)) {
      return undefined;
    }

    const currentProjectDirMatch = userInput.match(/当前项目的([A-Za-z0-9._-]+)目录/);
    const explicitDirMatch = userInput.match(/(?:存档|归档|保存|写入)到([A-Za-z0-9_./-]+)目录/);
    const directoryName = currentProjectDirMatch?.[1] ?? explicitDirMatch?.[1];

    if (!directoryName) {
      return undefined;
    }

    const workingDirectory = process.cwd();
    const targetDirectory = resolve(workingDirectory, directoryName);

    return {
      allowFilesystem: true,
      workingDirectory,
      targetPaths: [targetDirectory],
    };
  }

  private extractKeywords(input: string): string[] {
    const keywords: string[] = [];
    const seen = new Set<string>();
    const segments = input.split(/[\s，。？！、；：""''（）\[\]{}]+/).filter(Boolean);

    for (const segment of segments) {
      if (/^[a-zA-Z0-9][\w-]*$/.test(segment) && segment.length >= 2) {
        const normalized = segment.toLowerCase();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          keywords.push(segment);
        }
        continue;
      }

      if (segment.length >= 2 && !seen.has(segment)) {
        seen.add(segment);
        keywords.push(segment);
      }

      const chars = [...segment];
      for (let i = 0; i <= chars.length - 2; i++) {
        const bigram = chars[i] + chars[i + 1];
        if (!seen.has(bigram)) {
          seen.add(bigram);
          keywords.push(bigram);
        }
      }
    }

    return keywords.slice(0, 20);
  }
}
