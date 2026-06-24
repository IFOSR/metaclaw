import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

function readSource(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf-8');
}

describe('Execution planning architecture boundaries', () => {
  it('keeps executor routing decisions behind ExecutionPlanningService', () => {
    const sessionSource = readSource('src/session/metaclaw-session.ts');
    const executorCommandSource = readSource('src/commands/executor-commands.ts');
    const routingCoordinatorSource = readSource('src/core/executor-routing-coordinator.ts');
    const planningSource = readSource('src/core/execution-planning-service.ts');

    expect(sessionSource).not.toContain('new ExecutorRouter');
    expect(executorCommandSource).not.toContain('new ExecutorRouter');
    expect(executorCommandSource).toContain('ExecutionPlanningService');
    expect(sessionSource).toContain('ExecutorRoutingCoordinator');
    expect(sessionSource).not.toContain('executionPlanningService.plan');
    expect(routingCoordinatorSource).toContain('executionPlanningService.plan');
    expect(planningSource).toContain('new ExecutorRouter');
    expect(planningSource).toContain('ExecutionStrategyPlanner');
  });

  it('defines the ExecutionResult contract before runtime migration', () => {
    const planningSource = readSource('src/core/execution-planning-service.ts');

    expect(planningSource).toContain('export interface ExecutionResult');
    expect(planningSource).toContain("status: 'success' | 'failed' | 'blocked' | 'cancelled'");
    expect(planningSource).toContain('workUnitResults');
  });
});
