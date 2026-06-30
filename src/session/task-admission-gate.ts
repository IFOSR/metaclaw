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

      return rejectAdmission(runningTask, 'task control would start or resume another top-level task');
    }

    if (decision.task.binding === 'reference' && decision.task.taskId === runningTask.id) {
      return allowAdmission();
    }

    return rejectAdmission(runningTask, 'new top-level task intake is closed while a task is running');
  }

  evaluateExecution(input: ExecutionAdmissionInput): TaskAdmissionGateResult {
    const { taskId, runningTask } = input;
    if (!runningTask || runningTask.id === taskId) {
      return allowAdmission();
    }

    return rejectAdmission(runningTask, `execution request for #${taskId} conflicts with the active top-level task`);
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
      `-> MetaClaw: single active task gate rejected this request (${reason}).`,
      `-> Active top-level task: #${runningTask.id} ${runningTask.title}`,
      '-> Ask for status or finish/cancel the active task before starting another top-level task.',
    ],
  };
}
