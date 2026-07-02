import type { CapabilityClass } from '../core/capability-class.js';
import type { IntentDecisionV2 } from '../core/intent-orchestrator.js';

export type PlannerIntentAction =
  | 'no_action'
  | 'direct_reply'
  | 'task_control'
  | 'clarification'
  | 'plan_work_graph';

export interface PlannerIntentOutcome {
  action: PlannerIntentAction;
  capabilityClass: CapabilityClass;
  reason: string;
  confidence: number;
  control: string | null;
}

export class IntentRecognitionSkill {
  recognize(input: {
    userPrompt: string;
    intentDecision?: IntentDecisionV2 | null;
  }): PlannerIntentOutcome {
    const decision = input.intentDecision;
    if (!decision) {
      return {
        action: input.userPrompt.trim() ? 'plan_work_graph' : 'no_action',
        capabilityClass: 'general',
        reason: input.userPrompt.trim() ? 'default planner intake' : 'empty input',
        confidence: input.userPrompt.trim() ? 0.6 : 1,
        control: null,
      };
    }

    if (decision.interactionType === 'direct_reply') {
      return this.outcome('direct_reply', decision);
    }
    if (decision.interactionType === 'task_control') {
      return this.outcome('task_control', decision, decision.task.control);
    }
    if (decision.interactionType === 'clarification') {
      return this.outcome('clarification', decision);
    }

    return this.outcome('plan_work_graph', decision);
  }

  private outcome(
    action: PlannerIntentAction,
    decision: IntentDecisionV2,
    control: string | null = null,
  ): PlannerIntentOutcome {
    return {
      action,
      capabilityClass: decision.execution.capabilityClass ?? 'general',
      reason: decision.reason,
      confidence: decision.confidence,
      control,
    };
  }
}
