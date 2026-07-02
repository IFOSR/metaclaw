import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

function readSource(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf-8');
}

describe('Execution planning architecture boundaries', () => {
  it('keeps business dispatch in PlannerRoutingSkill and resource arbitration in WorkUnitClaimService', () => {
    const sessionSource = readSource('src/session/metaclaw-session.ts');
    const coordinatorSource = readSource('src/session/session-execution-coordinator.ts');
    const executorCommandSource = readSource('src/commands/executor-commands.ts');
    const plannerRoutingSource = readSource('src/planner/planner-routing-skill.ts');
    const strategyPlannerSource = readSource('src/core/execution-strategy-planner.ts');

    expect(sessionSource).not.toContain('new ExecutorRouter');
    expect(executorCommandSource).not.toContain('new ExecutorRouter');
    expect(sessionSource).not.toContain('ExecutorRoutingCoordinator');
    expect(coordinatorSource).not.toContain('resolveForTask');
    expect(coordinatorSource).not.toContain('ExecutionPolicyPlanner');
    expect(coordinatorSource).not.toContain('fallbackChain');
    expect(coordinatorSource).toContain('plannerRuntimeService.plan');
    expect(coordinatorSource).toContain('workUnitClaimService.claim');
    expect(executorCommandSource).not.toContain('ExecutionPlanningService');
    expect(executorCommandSource).toContain('PlannerRoutingSkill');
    expect(sessionSource).not.toContain('executionPlanningService.plan');
    expect(plannerRoutingSource).toContain('ExecutionStrategyPlanner');
    expect(plannerRoutingSource).not.toContain('ExecutionPolicy');
    expect(plannerRoutingSource).not.toContain('fallbackChain');
    expect(strategyPlannerSource).not.toContain('ExecutorRouteDecision');
    expect(strategyPlannerSource).not.toContain('routeDecision');
  });

  it('defines the ExecutionResult contract before runtime migration', () => {
    const planningSource = readSource('src/core/execution-planning-service.ts');

    expect(planningSource).toContain('export interface ExecutionResult');
    expect(planningSource).toContain("status: 'success' | 'failed' | 'blocked' | 'cancelled'");
    expect(planningSource).toContain('subtaskResults');
  });
});
