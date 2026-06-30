import type { IntentDecisionV2 } from '../core/intent-orchestrator.js';
import type { Task } from '../core/types.js';

export interface TaskAdmissionGateResult {
  allowed: boolean;
  lines: string[];
}

interface IntentAdmissionInput {
  decision: IntentDecisionV2;
  runningTask: Task | null;
}

interface ExecutionAdmissionInput {
  taskId: string;
  runningTask: Task | null;
}

export class TaskAdmissionGate {
  evaluateIntent(input: IntentAdmissionInput): TaskAdmissionGateResult {
    const { decision, runningTask } = input;
    if (!runningTask) {
      return allowAdmission();
    }

    if (decision.interactionType === 'direct_reply' || decision.interactionType === 'clarification') {
      return allowAdmission();
    }

    if (decision.interactionType === 'task_control') {
      if (decision.task.control === 'status_query' || decision.task.control === 'clear_tasks') {
        return allowAdmission();
      }

      if (decision.task.binding === 'reference' && decision.task.taskId === runningTask.id) {
        return allowAdmission();
      }

      return rejectAdmission(runningTask, '该任务控制会启动或恢复另一个顶层任务');
    }

    if (decision.task.binding === 'reference' && decision.task.taskId === runningTask.id) {
      return allowAdmission();
    }

    return rejectAdmission(runningTask, '已有任务在执行,暂不接纳新的顶层任务');
  }

  evaluateExecution(input: ExecutionAdmissionInput): TaskAdmissionGateResult {
    const { taskId, runningTask } = input;
    if (!runningTask || runningTask.id === taskId) {
      return allowAdmission();
    }

    return rejectAdmission(runningTask, `针对 #${taskId} 的执行请求与当前活跃顶层任务冲突`);
  }

  evaluateNewTopLevelTask(runningTask: Task | null, reason: string): TaskAdmissionGateResult {
    if (!runningTask) {
      return allowAdmission();
    }

    return rejectAdmission(runningTask, reason);
  }
}

function allowAdmission(): TaskAdmissionGateResult {
  return { allowed: true, lines: [] };
}

function rejectAdmission(runningTask: Task, reason: string): TaskAdmissionGateResult {
  return {
    allowed: false,
    lines: [
      `→ MetaClaw：单活跃任务限制已拒绝该请求(${reason})。`,
      `→ 当前活跃顶层任务：#${runningTask.id} ${runningTask.title}`,
      '→ 请先查询状态,或完成/取消当前任务,再开始新的顶层任务。',
    ],
  };
}
