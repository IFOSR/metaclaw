import type { ExecutorAdapter, ExecutorInput } from '../executor/adapter.js';
import type { ExecutionStrategy, ExecutionSubtask } from '../core/execution-strategy-planner.js';
import type { ExecutorResult, Task } from '../core/types.js';

export interface SubtaskResult {
  subtaskId: string;
  executorName: string;
  status: 'success' | 'failed' | 'timeout' | 'cancelled';
  output: string;
  artifacts: string[];
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface MultiExecutorOrchestrationResult {
  status: 'success' | 'blocked';
  results: SubtaskResult[];
  blockedReason?: string;
}

export interface MultiExecutorOrchestratorInput {
  strategy: Extract<ExecutionStrategy, { mode: 'multi_executor' }>;
  task: Task;
  userPrompt: string;
  executors: Map<string, ExecutorAdapter>;
  defaultExecutor: ExecutorAdapter;
  baseExecutorInput?: Partial<Omit<ExecutorInput, 'task' | 'userPrompt'>>;
}

function extractArtifactPaths(output: string): string[] {
  const paths = output.match(/(?:^|\s)([\w./-]+\.(?:md|txt|json|csv|ts|tsx|js|jsx|yaml|yml|html|pdf))/g) ?? [];
  return Array.from(new Set(paths.map(path => path.trim())));
}

function mapExecutorStatus(result: ExecutorResult): SubtaskResult['status'] {
  if (result.interrupted) {
    return 'cancelled';
  }
  if (!result.success && /timeout|timed out|超时/i.test(result.error ?? result.output)) {
    return 'timeout';
  }
  return result.success ? 'success' : 'failed';
}

function canRun(unit: ExecutionSubtask, completed: Set<string>): boolean {
  return unit.dependsOn.every(dep => completed.has(dep));
}

export class MultiExecutorOrchestrator {
  async run(input: MultiExecutorOrchestratorInput): Promise<MultiExecutorOrchestrationResult> {
    const pending = [...input.strategy.subtasks];
    const completed = new Set<string>();
    const results: SubtaskResult[] = [];

    while (pending.length > 0) {
      const runnable = pending.filter(unit => canRun(unit, completed));
      if (runnable.length === 0) {
        return {
          status: 'blocked',
          results,
          blockedReason: `subtask dependency cycle or missing dependency: ${pending.map(unit => unit.id).join(', ')}`,
        };
      }

      const batchResults = await Promise.all(runnable.map(unit => this.runSubtask(unit, input, results)));
      for (const result of batchResults) {
        results.push(result);
        if (result.status !== 'success') {
          return {
            status: 'blocked',
            results,
            blockedReason: `subtask ${result.subtaskId} failed on ${result.executorName}: ${result.error ?? result.output}`,
          };
        }
        completed.add(result.subtaskId);
      }

      for (const unit of runnable) {
        const index = pending.findIndex(item => item.id === unit.id);
        if (index >= 0) {
          pending.splice(index, 1);
        }
      }
    }

    return {
      status: 'success',
      results,
    };
  }

  private async runSubtask(
    unit: ExecutionSubtask,
    input: MultiExecutorOrchestratorInput,
    completedResults: SubtaskResult[],
  ): Promise<SubtaskResult> {
    const executor = input.executors.get(unit.executorHint) ?? input.defaultExecutor;
    const startedAt = new Date().toISOString();
    const result = await executor.execute({
      task: input.task,
      preferences: input.baseExecutorInput?.preferences ?? [],
      conversationHistory: input.baseExecutorInput?.conversationHistory ?? [],
      executionContextBundle: input.baseExecutorInput?.executionContextBundle,
      userPrompt: this.buildSubtaskPrompt(input.userPrompt, unit, completedResults),
      onProgress: input.baseExecutorInput?.onProgress,
    });
    const finishedAt = new Date().toISOString();

    return {
      subtaskId: unit.id,
      executorName: executor.name,
      status: mapExecutorStatus(result),
      output: result.output,
      artifacts: extractArtifactPaths(result.output),
      error: result.error,
      startedAt,
      finishedAt,
    };
  }

  private buildSubtaskPrompt(
    userPrompt: string,
    unit: ExecutionSubtask,
    completedResults: SubtaskResult[],
  ): string {
    const dependencyOutputs = completedResults
      .filter(result => unit.dependsOn.includes(result.subtaskId))
      .map(result => [
        `Dependency ${result.subtaskId} (${result.executorName}, ${result.status}):`,
        result.output.trim() || '(no output)',
      ].join('\n'));

    return [
      `Main task prompt: ${userPrompt}`,
      `Subtask: ${unit.title}`,
      `Goal: ${unit.goal}`,
      `Expected output: ${unit.expectedOutput}`,
      dependencyOutputs.length > 0 ? `Previous subtask outputs:\n\n${dependencyOutputs.join('\n\n')}` : '',
      unit.acceptance.length > 0 ? `Acceptance:\n${unit.acceptance.map(item => `- ${item}`).join('\n')}` : '',
      unit.inputs.resources.length > 0 ? `Resources:\n${unit.inputs.resources.join('\n')}` : '',
      unit.inputs.recalledTaskIds.length > 0 ? `Recalled task ids:\n${unit.inputs.recalledTaskIds.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
  }
}
