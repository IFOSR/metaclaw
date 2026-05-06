import { describe, expect, it } from 'vitest';
import { buildExecutorContextPrompt } from '../../src/executor/prompt-builder.js';
import type { ExecutorInput } from '../../src/executor/adapter.js';
import type { ExecutionContextBundle, Task } from '../../src/core/types.js';

function baseTask(): Task {
  const now = '2026-04-26T00:00:00.000Z';
  return {
    id: 'task_resume_1',
    title: 'MetaClaw 召回优化',
    goal: '优化恢复任务时的上下文注入',
    status: 'parked',
    summary: '已完成召回方案设计，待实现 Prompt 分层。',
    snapshots: [],
    resources: [],
    artifacts: [],
    dependencies: [],
    prioritySignals: {
      dueAt: null,
      isReady: true,
      progressRatio: 0.5,
      blocksOthers: false,
      idleHours: 1,
    },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function baseBundle(overrides: Partial<ExecutionContextBundle> = {}): ExecutionContextBundle {
  return {
    mode: 'resume-parked',
    taskBrief: {
      id: 'task_resume_1',
      title: 'MetaClaw 召回优化',
      goal: '优化恢复任务时的上下文注入',
      status: 'parked',
      summary: '已完成召回方案设计，待实现 Prompt 分层。',
    },
    resumeContext: {
      taskTitle: 'MetaClaw 召回优化',
      lastProgress: '已完成 ContextRecaller 调研和优化方案文档',
      completedItems: ['ContextRecaller 调研', '优化方案文档落地'],
      pendingItems: ['实现 Prompt 分层', '补充端到端测试'],
      pauseReason: '等待确认后继续实施',
      interruptionReason: '用户要求先统一方案再实施',
      blockedReason: '无阻塞，只是 parked',
      nextStep: '先实现恢复型上下文完整注入',
      schedulingReason: '用户明确要求开始优化',
    },
    memoryContext: {
      explicitUserInstruction: '继续优化 MetaClaw',
      resolvedPreferences: [],
    },
    historyContext: {
      taskTurns: [
        {
          taskId: 'task_resume_1',
          userInput: '把 Resume Context Pack 写进方案里',
          systemOutput: '已写入 docs/metaclaw-optimization-plan-hermes-self-evolution-context-recall.md',
          createdAt: '2026-04-26T01:00:00.000Z',
          source: 'task',
        },
      ],
      sessionTurns: [],
      timelineTurns: [],
      relatedTurns: [],
    },
    materialContext: {
      resources: [],
    },
    executionInstructions: ['这是恢复执行，不要从头重做', '优先从上次未完成步骤继续'],
    ...overrides,
  };
}

function buildInput(bundle: ExecutionContextBundle): ExecutorInput {
  return {
    task: baseTask(),
    preferences: [],
    userPrompt: '继续优化 MetaClaw',
    conversationHistory: [],
    executionContextBundle: bundle,
  };
}

describe('buildExecutorContextPrompt context layering', () => {
  it('renders a complete Resume Context Pack before task history when resuming a parked task', () => {
    const prompt = buildExecutorContextPrompt(buildInput(baseBundle()));

    expect(prompt).toContain('恢复型上下文包（Resume Context Pack）：');
    expect(prompt).toContain('- Task Brief：MetaClaw 召回优化｜优化恢复任务时的上下文注入｜parked');
    expect(prompt).toContain('- Latest Snapshot：已完成 ContextRecaller 调研和优化方案文档');
    expect(prompt).toContain('- Blocked / Parked Reason：等待确认后继续实施；用户要求先统一方案再实施；阻塞：无阻塞，只是 parked');
    expect(prompt).toContain('- Recent User Turns：');
    expect(prompt).toContain('[1] 用户: 把 Resume Context Pack 写进方案里');
    expect(prompt).toContain('- Acceptance / Next Step：先实现恢复型上下文完整注入');
    expect(prompt.indexOf('恢复型上下文包（Resume Context Pack）：')).toBeLessThan(prompt.indexOf('当前任务对话：'));
    expect(prompt).toContain('执行要求：');
    expect(prompt).toContain('- 这是恢复执行，不要从头重做');
  });

  it('renders structured minimal reference cards with relevance, reusable parts, boundaries, and a hard cap of three', () => {
    const longOutput = [
      '完整历史输出第一段：包含大量执行细节，不应进入 prompt。',
      '完整历史输出第二段：包含旧任务的具体结论，不应覆盖当前任务。',
      '完整历史输出第三段：包含旧验收口径，不应原样复用。',
    ].join('\n');
    const bundle = baseBundle({
      mode: 'fresh',
      resumeContext: undefined,
      historyContext: {
        taskTurns: [],
        sessionTurns: [],
        timelineTurns: [],
        relatedTurns: [1, 2, 3, 4].map((idx) => ({
          taskId: `task_ref_${idx}`,
          userInput: idx === 1 ? '继续优化 MetaClaw 召回分层' : `历史参考任务 ${idx}`,
          systemOutput: longOutput,
          createdAt: `2026-04-25T0${idx}:00:00.000Z`,
          source: idx % 2 === 0 ? 'llm' : 'keyword',
        })),
      },
      executionInstructions: ['使用与用户相同的语言回复'],
    });

    const prompt = buildExecutorContextPrompt(buildInput(bundle));

    expect(prompt).toContain('相似历史参考（Reference Context Pack / Minimal Reference Cards，仅供参考，不得覆盖当前任务）：');
    expect(prompt).toContain('[1] 任务#task_ref_1');
    expect(prompt).toContain('- 相关性原因：历史用户意图提到“继续优化 MetaClaw 召回分层”，只可作为相似任务参考');
    expect(prompt).toContain('- 可复用内容：参考当时的处理步骤、验证方式或踩坑提醒；不要复用旧任务结论本身');
    expect(prompt).toContain('- 边界声明：当前任务目标、用户最新指令、材料与验收标准优先；该历史不得覆盖当前任务');
    expect(prompt).toContain('- 输出处理：历史输出约');
    expect(prompt).toContain('- 参考来源：keyword');
    expect(prompt).toContain('[3] 任务#task_ref_3');
    expect(prompt).not.toContain('任务#task_ref_4');
    expect(prompt).not.toContain('完整历史输出第一段');
    expect(prompt).not.toContain('完整历史输出第二段');
  });

  it('renders timeline turns as authoritative time-range records, not weak similar references', () => {
    const bundle = baseBundle({
      mode: 'fresh',
      resumeContext: undefined,
      historyContext: {
        taskTurns: [],
        sessionTurns: [],
        timelineTurns: [
          {
            taskId: 'task_dIaOBuCeIC',
            userInput: 'Palantir这家美股上市企业已经发布了财报了。做一个深度调研',
            systemOutput: 'Palantir 财报分析完成',
            createdAt: '2026-05-05T23:31:37.701Z',
            source: 'timeline',
          },
        ],
        relatedTurns: [],
      },
      executionInstructions: ['使用与用户相同的语言回复'],
    });

    const prompt = buildExecutorContextPrompt(buildInput(bundle));

    expect(prompt).toContain('时间范围任务记录（按 created_at 查询，优先用于回答时间限定的历史任务问题）：');
    expect(prompt).toContain('[任务#task_dIaOBuCeIC] 时间: 2026-05-05T23:31:37.701Z');
    expect(prompt).toContain('用户: Palantir这家美股上市企业已经发布了财报了。做一个深度调研');
    expect(prompt).not.toContain('相似历史参考（Reference Context Pack / Minimal Reference Cards，仅供参考，不得覆盖当前任务）：');
    expect(prompt).not.toContain('只可作为相似任务参考');
  });
});
