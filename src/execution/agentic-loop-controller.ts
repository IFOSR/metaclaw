import { ExecutionAggregator, type ExecutionAggregationResult } from './execution-aggregator.js';
import type { ExecutionStrategy, ExecutionWorkUnit } from '../core/execution-strategy-planner.js';
import type { MultiExecutorOrchestrator, WorkUnitResult } from './multi-executor-orchestrator.js';
import type { ExecutorAdapter } from '../executor/adapter.js';
import type { Task } from '../core/types.js';

export interface AgenticLoopInput {
  strategy: Extract<ExecutionStrategy, { mode: 'multi_executor' }>;
  task: Task;
  userPrompt: string;
  executors: Map<string, ExecutorAdapter>;
  defaultExecutor: ExecutorAdapter;
  orchestrator: Pick<MultiExecutorOrchestrator, 'run'>;
  aggregator?: ExecutionAggregator;
}

export interface AgenticLoopResult {
  status: 'pass' | 'blocked';
  iterations: number;
  aggregation: ExecutionAggregationResult;
  results: WorkUnitResult[];
  blockedReason?: string;
}

function cloneStrategyWithWorkUnits(
  strategy: Extract<ExecutionStrategy, { mode: 'multi_executor' }>,
  workUnits: ExecutionWorkUnit[],
): Extract<ExecutionStrategy, { mode: 'multi_executor' }> {
  return {
    ...strategy,
    workUnits,
  };
}

function appendFeedbackToWorkUnit(unit: ExecutionWorkUnit, feedback: string, iteration: number): ExecutionWorkUnit {
  return {
    ...unit,
    goal: [
      unit.goal,
      '',
      `Agentic loop feedback iteration ${iteration}:`,
      feedback,
    ].join('\n'),
    acceptance: [
      ...unit.acceptance,
      `Address agentic loop feedback iteration ${iteration}`,
    ],
  };
}

export class AgenticLoopController {
  async run(input: AgenticLoopInput): Promise<AgenticLoopResult> {
    const aggregator = input.aggregator ?? new ExecutionAggregator();
    const maxIterations = Math.max(1, input.strategy.aggregation.maxIterations);
    let iteration = 1;
    let allResults: WorkUnitResult[] = [];
    let latestAggregation: ExecutionAggregationResult | null = null;
    let strategy = input.strategy;

    while (iteration <= maxIterations) {
      const orchestration = await input.orchestrator.run({
        strategy,
        task: input.task,
        userPrompt: input.userPrompt,
        executors: input.executors,
        defaultExecutor: input.defaultExecutor,
      });
      allResults = this.mergeResults(allResults, orchestration.results);

      if (orchestration.status === 'blocked') {
        latestAggregation = aggregator.aggregate({
          workUnits: strategy.workUnits,
          results: allResults,
          aggregation: strategy.aggregation,
        });
        return {
          status: 'blocked',
          iterations: iteration,
          aggregation: latestAggregation,
          results: allResults,
          blockedReason: orchestration.blockedReason,
        };
      }

      latestAggregation = aggregator.aggregate({
        workUnits: input.strategy.workUnits,
        results: allResults,
        aggregation: input.strategy.aggregation,
      });

      if (latestAggregation.status === 'pass') {
        return {
          status: 'pass',
          iterations: iteration,
          aggregation: latestAggregation,
          results: allResults,
        };
      }

      const retryUnits = this.buildRetryUnits(input.strategy.workUnits, latestAggregation, iteration);
      if (retryUnits.length === 0 || iteration >= maxIterations) {
        return {
          status: 'blocked',
          iterations: iteration,
          aggregation: latestAggregation,
          results: allResults,
          blockedReason: `验收未通过且已达到最大 agentic loop 迭代次数 ${maxIterations}`,
        };
      }

      strategy = cloneStrategyWithWorkUnits(input.strategy, retryUnits);
      iteration += 1;
    }

    if (!latestAggregation) {
      latestAggregation = aggregator.aggregate({
        workUnits: input.strategy.workUnits,
        results: allResults,
        aggregation: input.strategy.aggregation,
      });
    }

    return {
      status: 'blocked',
      iterations: maxIterations,
      aggregation: latestAggregation,
      results: allResults,
      blockedReason: `验收未通过且已达到最大 agentic loop 迭代次数 ${maxIterations}`,
    };
  }

  private buildRetryUnits(
    workUnits: ExecutionWorkUnit[],
    aggregation: ExecutionAggregationResult,
    iteration: number,
  ): ExecutionWorkUnit[] {
    const byId = new Map(workUnits.map(unit => [unit.id, unit]));
    return aggregation.retryFeedback
      .map(item => {
        const unit = byId.get(item.workUnitId);
        return unit ? appendFeedbackToWorkUnit(unit, item.feedback, iteration) : null;
      })
      .filter((unit): unit is ExecutionWorkUnit => Boolean(unit));
  }

  private mergeResults(existing: WorkUnitResult[], incoming: WorkUnitResult[]): WorkUnitResult[] {
    const byId = new Map(existing.map(result => [result.workUnitId, result]));
    for (const result of incoming) {
      byId.set(result.workUnitId, result);
    }
    return Array.from(byId.values());
  }
}
