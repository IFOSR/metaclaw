import { ExecutionAggregator, type ExecutionAggregationResult } from './execution-aggregator.js';
import type { ExecutionStrategy, ExecutionSubtask } from '../core/execution-strategy-planner.js';
import type { MultiExecutorOrchestrator, SubtaskResult } from './multi-executor-orchestrator.js';
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
  results: SubtaskResult[];
  blockedReason?: string;
}

function cloneStrategyWithSubtasks(
  strategy: Extract<ExecutionStrategy, { mode: 'multi_executor' }>,
  subtasks: ExecutionSubtask[],
): Extract<ExecutionStrategy, { mode: 'multi_executor' }> {
  return {
    ...strategy,
    subtasks,
  };
}

function appendFeedbackToSubtask(unit: ExecutionSubtask, feedback: string, iteration: number): ExecutionSubtask {
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
    let allResults: SubtaskResult[] = [];
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
          subtasks: strategy.subtasks,
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
        subtasks: input.strategy.subtasks,
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

      const retryUnits = this.buildRetryUnits(input.strategy.subtasks, latestAggregation, iteration);
      if (retryUnits.length === 0 || iteration >= maxIterations) {
        return {
          status: 'blocked',
          iterations: iteration,
          aggregation: latestAggregation,
          results: allResults,
          blockedReason: `验收未通过且已达到最大 agentic loop 迭代次数 ${maxIterations}`,
        };
      }

      strategy = cloneStrategyWithSubtasks(input.strategy, retryUnits);
      iteration += 1;
    }

    if (!latestAggregation) {
      latestAggregation = aggregator.aggregate({
        subtasks: input.strategy.subtasks,
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
    subtasks: ExecutionSubtask[],
    aggregation: ExecutionAggregationResult,
    iteration: number,
  ): ExecutionSubtask[] {
    const byId = new Map(subtasks.map(unit => [unit.id, unit]));
    return aggregation.retryFeedback
      .map(item => {
        const unit = byId.get(item.subtaskId);
        return unit ? appendFeedbackToSubtask(unit, item.feedback, iteration) : null;
      })
      .filter((unit): unit is ExecutionSubtask => Boolean(unit));
  }

  private mergeResults(existing: SubtaskResult[], incoming: SubtaskResult[]): SubtaskResult[] {
    const byId = new Map(existing.map(result => [result.subtaskId, result]));
    for (const result of incoming) {
      byId.set(result.subtaskId, result);
    }
    return Array.from(byId.values());
  }
}
