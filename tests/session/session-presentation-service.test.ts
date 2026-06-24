import { describe, expect, it } from 'vitest';
import { SessionPresentationService } from '../../src/session/session-presentation-service.js';
import { GuidanceActionType, type GuidanceProposal, type RuntimeState, type Task } from '../../src/core/types.js';

const baseTime = '2026-06-24T00:00:00.000Z';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_1',
    title: '默认任务',
    goal: '完成默认任务',
    status: 'ready',
    summary: '',
    snapshots: [],
    resources: [],
    artifacts: [],
    dependencies: [],
    prioritySignals: {
      dueAt: null,
      isReady: true,
      progressRatio: 0.25,
      blocksOthers: false,
      idleHours: 0,
      semanticPriorityReason: undefined,
    },
    injectedPreferences: [],
    lastSchedulingReason: '等待调度',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: baseTime,
    updatedAt: baseTime,
    ...overrides,
  };
}

function proposal(overrides: Partial<GuidanceProposal> = {}): GuidanceProposal {
  return {
    id: 'proposal_1',
    trigger: 'test',
    taskId: 'task_1',
    actionType: GuidanceActionType.RESUME_TASK,
    recommendedAction: '继续处理任务',
    reasons: ['上下文完整'],
    confidence: 0.91,
    requiresConfirmation: false,
    proposalPayload: {},
    expiresAt: null,
    createdAt: baseTime,
    ...overrides,
  };
}

describe('SessionPresentationService', () => {
  const presenter = new SessionPresentationService({ queueLimit: 2 });

  it('formats watchdog reminders without requiring MetaclawSession helpers', () => {
    const blocked = task({
      id: 'blocked_1',
      title: '权限任务',
      status: 'blocked',
      dependencies: [{
        taskId: 'blocked_1',
        type: 'manual',
        description: '权限授权',
        status: 'waiting',
        createdAt: baseTime,
      }],
    });
    const parked = task({
      id: 'parked_1',
      title: '挂起任务',
      status: 'parked',
      lastInterruptionReason: '被高优任务抢占',
      snapshots: [{
        done: ['完成调研'],
        pending: ['继续写报告'],
        nextStep: '补完结论',
        pauseReason: '抢占',
        createdAt: baseTime,
      }],
    });

    const lines = presenter.formatTaskPoolWatchdogReminder({
      blockedTasks: [blocked],
      parkedTasks: [parked],
      getWaitingBlockReason: task => task.dependencies[0]?.description ?? null,
    });

    expect(lines.join('\n')).toContain('任务池看护提醒');
    expect(lines.join('\n')).toContain('确认权限/授权后');
    expect(lines.join('\n')).toContain('下一步：补完结论');
  });

  it('creates latest guidance state and formats guidance/proposal blocks', () => {
    const suggestion = {
      taskId: 'task_1',
      recommendedAction: '继续处理任务 #task_1',
      reasons: ['阻塞已解除'],
    };

    const guidance = presenter.buildGuidanceState('解除阻塞后恢复', suggestion, '飞书云文档调研');
    expect(guidance.taskTitle).toBe('飞书云文档调研');

    const guidanceLines = presenter.formatGuidanceBlock('解除阻塞后恢复', suggestion, guidance.taskTitle);
    expect(guidanceLines.join('\n')).toContain('操作指引');
    expect(guidanceLines.join('\n')).toContain('目标任务：#task_1 飞书云文档调研');

    const proposalLines = presenter.formatProposalBlock('启动建议', proposal(), '飞书云文档调研');
    expect(proposalLines.join('\n')).toContain('操作提案');
    expect(proposalLines.join('\n')).toContain('置信度：0.91');
  });

  it('formats recall and last-task automatic decision blocks', () => {
    const recallLines = presenter.formatRecallReviewBlock({
      taskId: 'task_1',
      taskTitle: '调研任务',
      selectionItems: [{
        kind: 'preference',
        candidate: {
          scope: 'global',
          summary: '默认先给结论',
          reason: '长期偏好',
        },
      }],
    });
    expect(recallLines.join('\n')).toContain('记忆召回自动处理');
    expect(recallLines.join('\n')).toContain('[global] 默认先给结论');

    const lastTaskLines = presenter.formatLastTaskAutoDecisionBlock({
      completedTask: task({ id: 'done_1', title: '已完成任务', status: 'done' }),
      unfinishedTask: task({ id: 'parked_1', title: '最近未完成任务', status: 'parked' }),
      decision: 'resume-unfinished',
    });
    expect(lastTaskLines.join('\n')).toContain('恢复最近未完成任务 #parked_1 最近未完成任务');
  });

  it('formats execution guidance and task queue snapshots', () => {
    const parked = task({
      id: 'parked_1',
      title: '报告任务',
      status: 'parked',
      lastInterruptionReason: '被高优任务抢占',
      snapshots: [{
        done: ['完成大纲'],
        pending: ['写正文'],
        nextStep: '补正文',
        pauseReason: '抢占',
        createdAt: baseTime,
      }],
    });
    const resumeGuidance = presenter.formatResumeExecutionGuidance(parked);
    expect(resumeGuidance.reasons.join('\n')).toContain('刚被高优任务打断');
    expect(resumeGuidance.reasons.join('\n')).toContain('下一步已明确：补正文');

    const runtimeState: RuntimeState = {
      runningTaskId: 'running_1',
      runningExecutorName: null,
      readyTaskIds: ['ready_1'],
      blockedTaskIds: [],
      parkedTaskIds: ['parked_1'],
      lastEvent: null,
    };
    const lines = presenter.formatTaskQueueSnapshot({
      trigger: '任务开始执行',
      runtimeState,
      entries: [
        {
          task: task({ id: 'running_1', title: '运行中', status: 'running', prioritySignals: { ...task().prioritySignals, progressRatio: 0.5 } }),
          score: 8.5,
          reason: '当前正在执行',
          executionOrder: '正在执行',
        },
      ],
    });

    expect(lines.join('\n')).toContain('任务队列前五');
    expect(lines.join('\n')).toContain('[执行中] #running_1 运行中');
    expect(lines.join('\n')).toContain('进度 50%');
  });

  it('formats memory recall blocks, executor wizard summary, and failure hints', () => {
    const memoryLines = presenter.formatAutoAppliedMemoryBlock({
      taskId: 'task_1',
      taskTitle: '调研任务',
      preferenceCandidates: [{
        preferenceId: 'pref_1',
        summary: '默认先给结论',
        score: 90,
        reason: '命中偏好',
      }],
      taskCandidates: [{
        id: 'mem_task_1',
        title: '旧任务',
        score: 82,
        reason: '相似上下文',
      }],
    });
    expect(memoryLines.join('\n')).toContain('已自动采用记忆');
    expect(memoryLines.join('\n')).toContain('pref_1: 默认先给结论 score=0.90');

    const suppressedLines = presenter.formatSuppressedRecallBlock({
      taskId: 'task_1',
      taskTitle: '调研任务',
      preferenceCount: 2,
      taskMemoryCount: 1,
    });
    expect(suppressedLines.join('\n')).toContain('已跳过不确定记忆');
    expect(suppressedLines.join('\n')).toContain('跳过：2 条偏好，1 条任务记忆');

    const wizardSummary = presenter.formatExecutorRegisterWizardSummary({
      name: 'claude',
      projectUrl: 'https://example.test',
      runtimeCommand: 'claude',
      runtimeArgs: ['--print', '{prompt}'],
      runtimeCheckCommand: 'which claude',
      domains: ['code'],
      capabilities: ['review'],
    });
    expect(wizardSummary).toContain('Executor 注册信息');
    expect(wizardSummary).toContain('args=--print {prompt}');

    expect(presenter.buildVerificationFailureHint('task_1')).toContain('补充缺失的测试证据');
    expect(presenter.buildRecoverableFailureHint('task_1', 'Permission denied')).toContain('确认相关目录权限');
    expect(presenter.buildRecoverableFailureHint('task_1', 'executor idle timeout')).toContain('执行器长时间没有输出');
  });
});
