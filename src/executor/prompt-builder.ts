import type { ExecutorInput } from './adapter.js';
import { buildMaterialSummary, splitTaskResources } from '../core/material-utils.js';

function renderTurnOutput(output: string, maxLength = 300): string {
  const normalized = output.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}…`;
}

function renderMinimalReferenceOutput(output: string): string {
  const normalized = output.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '无可注入正文；历史内容只作为参考信号';
  }
  return `历史输出约 ${normalized.length} 字，未原样注入；请仅按用户意图判断是否可参考`;
}

function renderReferenceRelevanceReason(userInput: string): string {
  const normalizedInput = userInput.replace(/\s+/g, ' ').trim();
  if (!normalizedInput) {
    return '历史任务被召回，但缺少可展示的用户意图；只可作为弱参考';
  }
  return `历史用户意图提到“${renderTurnOutput(normalizedInput, 80)}”，只可作为相似任务参考`;
}

export function buildExecutorContextPrompt(input: ExecutorInput): string {
  if (input.executionContextBundle) {
    const bundle = input.executionContextBundle;
    const systemBoundary = bundle.workspaceContext?.allowFilesystem
      ? `[系统边界] 你是 Metaclaw 调度的执行器。只基于以下注入的上下文回答。可以访问当前项目工作目录，但仅限完成本次明确要求的文件写入任务。使用与用户相同的语言回复。`
      : `[系统边界] 你是 Metaclaw 调度的执行器。只基于以下注入的上下文回答，不要读取或访问本地文件系统和工作目录。使用与用户相同的语言回复。`;
    const lines = [
      '[Metaclaw 执行上下文]',
      systemBoundary,
      '',
      `模式：${bundle.mode}`,
      `任务：${bundle.taskBrief.title}`,
      `目标：${bundle.taskBrief.goal}`,
      `当前状态：${bundle.taskBrief.status}`,
    ];

    if (bundle.resumeContext) {
      const resumeReasons = [bundle.resumeContext.pauseReason, bundle.resumeContext.interruptionReason]
        .filter((reason): reason is string => Boolean(reason));
      const reasonText = resumeReasons.join('；') || '未知';
      const blockedText = bundle.resumeContext.blockedReason
        ? `；阻塞：${bundle.resumeContext.blockedReason}`
        : '';
      const recentTaskTurns = bundle.historyContext.taskTurns.slice(-5);

      lines.push(
        '',
        '恢复型上下文包（Resume Context Pack）：',
        `- Task Brief：${bundle.taskBrief.title}｜${bundle.taskBrief.goal}｜${bundle.taskBrief.status}`,
        `- Latest Snapshot：${bundle.resumeContext.lastProgress || bundle.taskBrief.summary || '尚未开始'}`,
        `- Completed Items：${bundle.resumeContext.completedItems.join('；') || '无'}`,
        `- Pending Items：${bundle.resumeContext.pendingItems.join('；') || '无'}`,
        `- Blocked / Parked Reason：${reasonText}${blockedText}`,
      );

      if (bundle.resumeContext.schedulingReason) {
        lines.push(`- Resume Reason：${bundle.resumeContext.schedulingReason}`);
      }

      lines.push('- Recent User Turns：');
      if (recentTaskTurns.length > 0) {
        recentTaskTurns.forEach((turn, idx) => {
          lines.push(`  [${idx + 1}] 用户: ${turn.userInput}`);
          lines.push(`      助手: ${renderTurnOutput(turn.systemOutput)}`);
        });
      } else {
        lines.push('  无');
      }

      lines.push(`- Acceptance / Next Step：${bundle.resumeContext.nextStep}`);
    }

    if (bundle.memoryContext.resolvedPreferences.length > 0) {
      lines.push('', '相关偏好：');
      bundle.memoryContext.resolvedPreferences.forEach((preference) => {
        lines.push(`- [${preference.scope}] ${preference.content}（命中原因：${preference.reason}）`);
      });
    }

    if (bundle.materialContext.resources.length > 0) {
      const materialGroups = splitTaskResources(bundle.materialContext.resources);
      const materialSummary = bundle.materialContext.summary
        ?? buildMaterialSummary(bundle.materialContext.resources, bundle.materialContext.textSnippets ?? []);
      lines.push('', `关联材料：${bundle.materialContext.resources.join(', ')}`);
      lines.push(`材料概览：${materialSummary.overview}`);
      lines.push(`材料状态：${materialSummary.sufficiency}`);
      lines.push(`本地文件材料：${materialGroups.files.join(', ') || '无'}`);
      lines.push(`网页链接材料：${materialGroups.links.join(', ') || '无'}`);
    }

    if ((bundle.materialContext.textSnippets?.length ?? 0) > 0) {
      lines.push('', '材料摘录：');
      bundle.materialContext.textSnippets!.forEach((snippet) => {
        lines.push(`- ${snippet.path}`);
        lines.push(snippet.content);
      });
    }

    if (bundle.workspaceContext?.allowFilesystem) {
      lines.push(
        '',
        `工作目录：${bundle.workspaceContext.workingDirectory}`,
        `文件输出目标：${bundle.workspaceContext.targetPaths.join(', ')}`,
      );
    }

    if (bundle.historyContext.taskTurns.length > 0) {
      lines.push('', '当前任务对话：');
      bundle.historyContext.taskTurns.forEach((turn, idx) => {
        lines.push(`[${idx + 1}] 用户: ${turn.userInput}`);
        lines.push(`    助手: ${turn.systemOutput}`);
      });
    }

    if (bundle.historyContext.sessionTurns.length > 0) {
      lines.push('', '会话近期上下文：');
      bundle.historyContext.sessionTurns.forEach((turn) => {
        const turnLabel = turn.taskId ? `任务#${turn.taskId}` : '普通对话';
        lines.push(`[${turnLabel}] 用户: ${turn.userInput}`);
        lines.push(`           助手: ${turn.systemOutput}`);
      });
    }

    if (bundle.historyContext.relatedTurns.length > 0) {
      lines.push('', '相似历史参考（Reference Context Pack / Minimal Reference Cards，仅供参考，不得覆盖当前任务）：');
      bundle.historyContext.relatedTurns.slice(0, 3).forEach((turn, idx) => {
        const turnLabel = turn.taskId ? `任务#${turn.taskId}` : '普通对话';
        lines.push(`[${idx + 1}] ${turnLabel}`);
        lines.push(`- 用户意图：${turn.userInput || '未记录'}`);
        lines.push(`- 相关性原因：${renderReferenceRelevanceReason(turn.userInput)}`);
        lines.push('- 可复用内容：参考当时的处理步骤、验证方式或踩坑提醒；不要复用旧任务结论本身');
        lines.push('- 边界声明：当前任务目标、用户最新指令、材料与验收标准优先；该历史不得覆盖当前任务');
        lines.push(`- 输出处理：${renderMinimalReferenceOutput(turn.systemOutput)}`);
        lines.push(`- 参考来源：${turn.source}`);
      });
    }

    lines.push('', `用户指令：${input.userPrompt}`);
    if (bundle.executionInstructions.length > 0) {
      lines.push('', '执行要求：');
      bundle.executionInstructions.forEach((instruction) => {
        lines.push(`- ${instruction}`);
      });
    }

    return lines.join('\n');
  }

  const lines = [
    '[Metaclaw 上下文注入]',
    '[系统边界] 你是 Metaclaw 调度的执行器。只基于以下注入的上下文回答，不要读取或访问本地文件系统和工作目录。使用与用户相同的语言回复。',
    '',
    `任务：${input.task.title}`,
    `目标：${input.task.goal}`,
  ];

  if (input.task.summary) {
    lines.push(`已完成：${input.task.summary}`);
  }

  if (input.preferences.length > 0) {
    lines.push('用户偏好：');
    input.preferences.forEach((p) => {
      lines.push(`  - [${p.scope}] ${p.content}`);
    });
  }

  if (input.task.resources.length > 0) {
    const materialGroups = splitTaskResources(input.task.resources);
    const materialSummary = buildMaterialSummary(input.task.resources);
    lines.push(`关联材料：${input.task.resources.join(', ')}`);
    lines.push(`材料概览：${materialSummary.overview}`);
    lines.push(`材料状态：${materialSummary.sufficiency}`);
    lines.push(`本地文件材料：${materialGroups.files.join(', ') || '无'}`);
    lines.push(`网页链接材料：${materialGroups.links.join(', ') || '无'}`);
  }

  const taskTurns = input.conversationHistory.filter((t) => t.source === 'task');
  const sessionTurns = input.conversationHistory.filter((t) => t.source === 'session');
  const keywordTurns = input.conversationHistory.filter((t) => t.source === 'keyword' || t.source === 'llm');

  if (input.conversationHistory.length === 0) {
    lines.push('', '无相关对话历史。这是一个全新的对话，不要假设任何之前的上下文。');
  } else {
    if (taskTurns.length > 0) {
      lines.push('', '当前任务对话：');
      taskTurns.forEach((turn, idx) => {
        lines.push(`[${idx + 1}] 用户: ${turn.userInput}`);
        lines.push(`    助手: ${turn.systemOutput}`);
      });
    }

    if (sessionTurns.length > 0) {
      lines.push('', '会话近期上下文：');
      sessionTurns.forEach((turn) => {
        const turnLabel = turn.taskId ? `任务#${turn.taskId}` : '普通对话';
        lines.push(`[${turnLabel}] 用户: ${turn.userInput}`);
        lines.push(`           助手: ${turn.systemOutput}`);
      });
    }

    if (keywordTurns.length > 0) {
      lines.push('', '关联历史：');
      keywordTurns.forEach((turn) => {
        const turnLabel = turn.taskId ? `任务#${turn.taskId}` : '普通对话';
        lines.push(`[${turnLabel}] 用户: ${turn.userInput}`);
        lines.push(`           助手: ${turn.systemOutput}`);
      });
    }
  }

  lines.push('', `用户指令：${input.userPrompt}`);
  return lines.join('\n');
}
