import type { AcceptanceCriterion } from './execution-strategy-planner.js';
import type {
  ExecutionStrategy,
  ExecutionWorkUnit,
} from './execution-strategy-planner.js';
import type { CapabilityClass } from './capability-class.js';

export type ExecutionPolicyMode = 'single_executor' | 'multi_executor';
export type VerificationLevel = 'none' | 'compile' | 'test' | 'review';
export type ExecutionRiskLevel = 'low' | 'medium' | 'high';
export type EstimatedCostClass = 'cheap' | 'moderate' | 'expensive';

export interface ExecutionPolicy {
  taskId: string;
  mode: ExecutionPolicyMode;
  primaryExecutor: string;
  candidateExecutors: string[];
  isolationRequired: boolean;
  verificationLevel: VerificationLevel;
  reviewerExecutor: string | null;
  riskLevel: ExecutionRiskLevel;
  estimatedCostClass: EstimatedCostClass;
  fallbackChain: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  capabilityClasses: CapabilityClass[];
  reason: string;
  strategy: ExecutionStrategy;
  workUnits: ExecutionWorkUnit[];
}
