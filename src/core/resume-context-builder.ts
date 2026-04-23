import type { ConversationTurn } from '../executor/adapter.js';
import type { ContextRecaller } from './context-recaller.js';
import type { MemoryEngine } from './memory-engine.js';
import type { TaskMemoryDocument } from './task-embedding-service.js';
import type { TaskEngine } from './task-engine.js';
import type { ExecutionContextBundle, ResolvedPreference, Task, TaskSnapshot, WorkspaceContext } from './types.js';
import { buildMaterialSummary, extractMaterialTextSnippets } from './material-utils.js';
import { resolve } from 'path';

interface BuildContextInput {
  taskId: string;
  mode: 'fresh' | 'resume-parked' | 'resume-blocked' | 'follow-up';
  userInput: string;
  sessionId: string;
  schedulingReason?: string;
  newlyProvidedResources?: string[];
  resolvedPreferencesOverride?: ResolvedPreference[];
  relatedTaskIdsOverride?: string[];
  acceptedMemoryResources?: string[];
}

interface TaskMemoryDocumentBuildInput {
  latestSnapshot?: TaskSnapshot | null;
  materialSummary?: string | null;
}

export function buildTaskMemoryDocuments(
  task: Pick<Task, 'id' | 'title' | 'goal' | 'summary'> & { snapshots?: TaskSnapshot[] },
  input: TaskMemoryDocumentBuildInput = {},
): TaskMemoryDocument[] {
  const documents: TaskMemoryDocument[] = [];
  const latestSnapshot = input.latestSnapshot ?? task.snapshots?.[task.snapshots.length - 1] ?? null;

  documents.push({
    taskId: task.id,
    memoryKind: 'task_summary',
    sourceId: task.id,
    text: [
      `任务标题：${task.title}`,
      `任务目标：${task.goal}`,
      `最新总结：${task.summary || '暂无总结'}`,
    ].join('\n'),
  });

  if (latestSnapshot) {
    documents.push({
      taskId: task.id,
      memoryKind: 'snapshot_summary',
      sourceId: `${task.id}:latest_snapshot`,
      text: [
        `任务标题：${task.title}`,
        `已完成：${latestSnapshot.done.join('；') || '暂无'}`,
        `待处理：${latestSnapshot.pending.join('；') || '暂无'}`,
        `下一步：${latestSnapshot.nextStep || '暂无'}`,
        `暂停原因：${latestSnapshot.pauseReason || '暂无'}`,
      ].join('\n'),
    });
  }

  if (input.materialSummary) {
    documents.push({
      taskId: task.id,
      memoryKind: 'material_summary',
      sourceId: `${task.id}:material_summary`,
      text: [
        `任务标题：${task.title}`,
        `材料摘要：${input.materialSummary}`,
      ].join('\n'),
    });
  }

  return documents;
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
    const relatedTaskTurns = input.relatedTaskIdsOverride
      ? this.contextRecaller.recallForTaskIds(input.relatedTaskIdsOverride)
      : [];
    const latestSnapshot = this.taskEngine.getLatestSnapshot(task.id);
    const keywords = this.extractKeywords(input.userInput);
    const resolvedPreferences = input.resolvedPreferencesOverride
      ?? this.memoryEngine.recall({
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
      ...(input.acceptedMemoryResources ?? []),
    ]));
    const textSnippets = await extractMaterialTextSnippets(resources, {
      fetchImpl: this.fetchImpl,
    });
    const materialSummary = buildMaterialSummary(resources, textSnippets);

    const blockedReason = task.dependencies.find(dependency => dependency.status === 'waiting')?.description
      ?? task.dependencies[task.dependencies.length - 1]?.description;
    const workspaceContext = this.buildWorkspaceContext(task, input.userInput);
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
        relatedTurns: this.mergeRelatedTurns(
          conversationHistory.filter(turn => turn.source === 'keyword' || turn.source === 'llm'),
          relatedTaskTurns,
        ),
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
          '所有本次任务生成的文件都必须放在任务专属输出目录中，不要写到其他位置',
          `工作目录：${workspaceContext.workingDirectory}`,
          ...workspaceContext.targetPaths.map(path => `目标目录：${path}`),
          '如果目标目录不存在，请先创建目录，再写入一个合适命名的 Markdown 文件',
          '不要在回复中粘贴或打印完整文件内容，只返回简短摘要和最终文件路径',
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

  private buildWorkspaceContext(task: Task, userInput: string): WorkspaceContext | undefined {
    if (!this.isFileGenerationRequest(userInput)) {
      return undefined;
    }

    const workingDirectory = process.cwd();
    const targetDirectory = resolve(workingDirectory, 'metaclaw-tasks', task.id);

    return {
      allowFilesystem: true,
      workingDirectory,
      targetPaths: [targetDirectory],
    };
  }

  private isFileGenerationRequest(userInput: string): boolean {
    return /(存档|归档|保存|写入|落盘|导出)|((生成|创建|输出|产出|制作).*(html|HTML|markdown|md|json|csv|txt|yaml|yml|文件))/u.test(userInput);
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

  private mergeRelatedTurns(
    primary: ConversationTurn[],
    additional: ConversationTurn[],
  ): ConversationTurn[] {
    const merged = new Map<string, ConversationTurn>();

    for (const turn of [...primary, ...additional]) {
      const key = `${turn.taskId}:${turn.createdAt}:${turn.userInput}`;
      if (!merged.has(key)) {
        merged.set(key, turn);
      }
    }

    return Array.from(merged.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}
