import type { ExecutionPlan } from '../session/session-helpers.js';
import type { AgentClass, Subtask, Task } from '../core/types.js';
import type { IntentDecisionV2 } from '../core/intent-orchestrator.js';
import { generateInteractionId } from '../utils/id.js';
import { IntentRecognitionSkill, type PlannerIntentOutcome } from './intent-recognition-skill.js';
import { PlannerRoutingSkill, type WorkGraphPlan } from './planner-routing-skill.js';
import { SubtaskRepo } from '../storage/subtask-repo.js';
import { TaskEventRepo } from '../storage/task-event-repo.js';

export interface PlannerRuntimeResult {
  intent: PlannerIntentOutcome;
  workGraph: WorkGraphPlan | null;
  subtasks: Subtask[];
}

export class PlannerRuntimeService {
  constructor(
    private readonly subtaskRepo: SubtaskRepo,
    private readonly taskEventRepo: TaskEventRepo,
    private readonly intentSkill = new IntentRecognitionSkill(),
    private readonly routingSkill = new PlannerRoutingSkill(),
  ) {}

  plan(input: {
    task: Task;
    userPrompt: string;
    taskExecutionPlan: ExecutionPlan;
    intentDecision?: IntentDecisionV2 | null;
    agentClasses: AgentClass[];
    resources: string[];
    recalledTaskIds?: string[];
  }): PlannerRuntimeResult {
    const intent = this.intentSkill.recognize({
      userPrompt: input.userPrompt,
      intentDecision: input.intentDecision,
    });
    this.recordTaskEvent(input.task.id, null, 'planner_intent_recognized', intent.reason, {
      action: intent.action,
      capabilityClass: intent.capabilityClass,
      confidence: intent.confidence,
    });

    if (intent.action !== 'plan_work_graph') {
      this.recordTaskEvent(input.task.id, null, intent.action, intent.reason, {});
      return {
        intent,
        workGraph: null,
        subtasks: [],
      };
    }

    const existing = this.subtaskRepo.listByTask(input.task.id);
    if (existing.length > 0) {
      const resumed = existing.map(subtask => {
        if (subtask.status === 'done' || subtask.status === 'running') {
          return subtask;
        }
        const readySubtask = {
          ...subtask,
          status: 'ready' as const,
          error: null,
        };
        this.subtaskRepo.upsert(readySubtask);
        this.recordTaskEvent(input.task.id, readySubtask.id, 'subtask_resumed', readySubtask.title, {});
        return readySubtask;
      });
      return {
        intent,
        workGraph: {
          taskId: input.task.id,
          reason: 'reusing existing persisted work graph',
          subtasks: resumed.map(subtask => ({
            id: subtask.id,
            title: subtask.title,
            goal: subtask.goal,
            dependsOn: subtask.dependsOn,
            requiredAgentClassKind: subtask.requiredAgentClassKind,
            agentClassHint: subtask.agentClassHint,
            candidateAgentClasses: subtask.candidateAgentClasses,
            expectedOutput: subtask.expectedOutput,
            acceptance: subtask.acceptance,
            riskLevel: subtask.riskLevel,
          })),
        },
        subtasks: resumed,
      };
    }

    const workGraph = this.routingSkill.plan(input);
    const now = new Date().toISOString();
    const subtasks = workGraph.subtasks.map(plan => ({
      ...plan,
      taskId: input.task.id,
      status: 'ready' as const,
      result: '',
      error: null,
      createdAt: now,
      updatedAt: now,
    }));
    for (const subtask of subtasks) {
      this.subtaskRepo.upsert(subtask);
      this.recordTaskEvent(input.task.id, subtask.id, 'subtask_planned', subtask.title, {
        dependsOn: subtask.dependsOn,
        candidateAgentClasses: subtask.candidateAgentClasses,
      });
    }
    this.recordTaskEvent(input.task.id, null, 'work_graph_planned', workGraph.reason, {
      subtaskIds: subtasks.map(subtask => subtask.id),
    });

    return {
      intent,
      workGraph,
      subtasks,
    };
  }

  private recordTaskEvent(
    taskId: string,
    subtaskId: string | null,
    eventType: string,
    message: string,
    payload: Record<string, unknown>,
  ): void {
    this.taskEventRepo.insert({
      id: `te_${generateInteractionId()}`,
      taskId,
      subtaskId,
      eventType,
      message,
      payload,
      createdAt: new Date().toISOString(),
    });
  }
}
