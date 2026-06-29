// Execution planning module that turns task intent and executor profiles into an ExecutionPolicy.
import type { ExecutionPlan } from '../session/session-helpers.js';
import { ExecutionPolicyPlanner } from '../routing/execution-policy-planner.js';
import type { ExecutorProfile, IntentDecision } from './executor-router.js';
import type { ExecutionPolicy } from './execution-policy.js';
import type { IntentDecisionV2 } from './intent-orchestrator.js';
import type { WorkUnitResult } from './multi-executor-orchestrator.js';
import type { ExecutionContextBundleV2, ResolvedPreference, Task } from './types.js';

export interface ExecutionPlanningInput {
  task: Task;
  userPrompt: string;
  taskExecutionPlan: ExecutionPlan;
  intentDecision?: IntentDecisionV2 | null;
  semanticDecision?: IntentDecision | null;
  executorProfiles: ExecutorProfile[];
  defaultExecutorName: string;
  resources: string[];
  recalledTaskIds?: string[];
}

export interface ExecutionResult {
  taskId: string;
  executionId: string;
  status: 'success' | 'failed' | 'blocked' | 'cancelled';
  executorName: string;
  output: string;
  error: string | null;
  artifacts: string[];
  workUnitResults: WorkUnitResult[];
  durationMs: number;
  userPrompt: string;
  preferences: ResolvedPreference[];
  context: ExecutionContextBundleV2;
  recovery: {
    recoverable: boolean;
    blockReason: string | null;
  };
  runtime: {
    attemptedExecutors: string[];
    fallbackExecutors: string[];
    fallbackReason: string | null;
    fallbackLines: string[];
  };
}

export class ExecutionPlanningService {
  constructor(private readonly policyPlanner = new ExecutionPolicyPlanner()) {}

  plan(input: ExecutionPlanningInput): ExecutionPolicy {
    return this.policyPlanner.plan(input);
  }
}
