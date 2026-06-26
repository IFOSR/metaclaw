import type Database from 'better-sqlite3';
import type { ExecutorAdapter, ExecutorInput, ExecutorProgressEvent } from '../executor/adapter.js';
import { ClaudeCodeAdapter } from '../executor/claude-code.js';
import { CodexCliAdapter } from '../executor/codex-cli.js';
import { CustomCliExecutorAdapter } from '../executor/custom-cli.js';
import { DeepSeekTuiAdapter } from '../executor/deepseek-tui.js';
import { HermesAgentAdapter } from '../executor/hermes-agent.js';
import { OpenClawAdapter } from '../executor/openclaw.js';
import { PiAgentAdapter } from '../executor/pi-agent.js';
import { ExecutorProfileRepo } from '../storage/executor-profile-repo.js';
import type { Config, ExecutorResult } from './types.js';
import type { ExecutionPlanV2, ExecutionResult } from './execution-planning-service.js';
import type { ExecutionStrategy } from './execution-strategy-planner.js';
import { MultiExecutorOrchestrator, type WorkUnitResult } from './multi-executor-orchestrator.js';
import { AgenticLoopController } from './agentic-loop-controller.js';

export interface ExecutorRegistryDeps {
  db: Database.Database;
  config: Config;
  defaultExecutor: ExecutorAdapter;
  executorFactory?: (name: string) => ExecutorAdapter | null;
  adapterRegistry?: ExecutorAdapterRegistry;
}

interface AdapterFactoryConfig {
  timeout: number;
  maxDuration?: number;
  workspaceRoot: string;
}

export type AdapterFactory = (config: AdapterFactoryConfig) => ExecutorAdapter;

function withLongResearchTimeoutDefaults<T extends AdapterFactoryConfig>(config: T): T {
  return {
    ...config,
    timeout: Math.max(config.timeout, 900),
    maxDuration: Math.max(config.maxDuration ?? 0, 7200),
  };
}

export class ExecutorAdapterRegistry {
  private readonly factories = new Map<string, AdapterFactory>();
  private readonly commandAliases = new Map<string, string>();

  register(name: string, factory: AdapterFactory, commandAliases: string[] = []): this {
    this.factories.set(name, factory);
    this.commandAliases.set(name, name);
    for (const alias of commandAliases) {
      this.commandAliases.set(alias, name);
    }
    return this;
  }

  create(name: string, config: AdapterFactoryConfig): ExecutorAdapter | null {
    const factory = this.factories.get(name);
    return factory ? factory(config) : null;
  }

  createByCommand(command: string, config: AdapterFactoryConfig): ExecutorAdapter | null {
    const name = this.commandAliases.get(command);
    return name ? this.create(name, config) : null;
  }
}

export function createDefaultExecutorAdapterRegistry(): ExecutorAdapterRegistry {
  return new ExecutorAdapterRegistry()
    .register('codex-cli', config => new CodexCliAdapter({ ...config, command: 'codex' }), ['codex'])
    .register('claude-code', config => new ClaudeCodeAdapter({ ...config, command: 'claude' }), ['claude'])
    .register('hermes-agent', config => new HermesAgentAdapter(withLongResearchTimeoutDefaults({ ...config, command: 'hermes' })), ['hermes'])
    .register('pi-agent', config => new PiAgentAdapter(withLongResearchTimeoutDefaults({ ...config, command: 'pi' })), ['pi'])
    .register('deepseek-tui', config => new DeepSeekTuiAdapter({ ...config, command: 'deepseek-tui' }), ['deepseek', 'deepseek-tui'])
    .register('openclaw', config => new OpenClawAdapter({ ...config, command: 'openclaw' }), ['openclaw']);
}

export class ExecutorRegistry {
  private readonly adapterRegistry: ExecutorAdapterRegistry;

  constructor(private readonly deps: ExecutorRegistryDeps) {
    this.adapterRegistry = deps.adapterRegistry ?? createDefaultExecutorAdapterRegistry();
  }
  resolve(name: string): ExecutorAdapter | null {
    if (name === this.deps.defaultExecutor.name) {
      return this.deps.defaultExecutor;
    }

    const injected = this.deps.executorFactory?.(name);
    if (injected) {
      return injected;
    }

    const registered = this.adapterRegistry.create(name, {
      timeout: this.deps.config.executor.timeout,
      maxDuration: this.deps.config.executor.max_duration,
      workspaceRoot: process.cwd(),
    });
    if (registered) {
      return registered;
    }

    const customProfile = new ExecutorProfileRepo(this.deps.db).findByName(name);
    if (!customProfile?.runtimeCommand) {
      return null;
    }

    return new CustomCliExecutorAdapter({
      name,
      command: customProfile.runtimeCommand,
      args: customProfile.runtimeArgs ?? [],
      checkCommand: customProfile.runtimeCheckCommand,
      timeout: this.deps.config.executor.timeout,
      maxDuration: this.deps.config.executor.max_duration,
      workspaceRoot: process.cwd(),
    });
  }

  resolveRequired(name: string): ExecutorAdapter {
    return this.resolve(name) ?? this.deps.defaultExecutor;
  }
}

export function createDefaultExecutor(config: {
  command: string;
  timeout: number;
  maxDuration?: number;
  workspaceRoot?: string;
}): ExecutorAdapter {
  const workspaceRoot = config.workspaceRoot ?? process.cwd();
  const adapterConfig = {
    timeout: config.timeout,
    maxDuration: config.maxDuration,
    workspaceRoot,
  };
  const registry = createDefaultExecutorAdapterRegistry();
  return registry.createByCommand(config.command, adapterConfig)
    ?? registry.create('claude-code', adapterConfig)!;
}

export interface ExecutionRuntimeRunInput {
  taskId: string;
  executionId: string;
  plan: ExecutionPlanV2;
  executorInput: Omit<ExecutorInput, 'onProgress'>;
  onProgress: (event: ExecutorProgressEvent, executor: ExecutorAdapter) => void;
}

interface ExecutorRaceResult {
  executor: ExecutorAdapter;
  result: ExecutorResult;
  abortedExecutors: string[];
}

export class ExecutionRuntime {
  constructor(
    private readonly registry: ExecutorRegistry,
    private readonly defaultExecutor: ExecutorAdapter,
    private readonly multiExecutorOrchestrator = new MultiExecutorOrchestrator(),
    private readonly agenticLoopController = new AgenticLoopController(),
  ) {}

  async run(input: ExecutionRuntimeRunInput): Promise<ExecutionResult> {
    if (input.plan.mode === 'multi_executor') {
      return this.runMultiExecutor(input);
    }

    const selectedExecutor = this.registry.resolveRequired(input.plan.selectedExecutor);
    const raceExecutors = this.resolveRuntimeExecutors(input.plan, selectedExecutor);
    const raceResult = await this.executeWithOptionalRace(raceExecutors, input.executorInput, input.onProgress);
    let { executor, result } = raceResult;
    let fallbackReason: string | null = null;
    let fallbackLines: string[] = [];

    if (!result.success && executor.name !== 'codex-cli') {
      const fallback = await this.executeCodexFallback({
        failedExecutor: executor,
        failedResult: result,
        executorInput: input.executorInput,
        onProgress: input.onProgress,
      });
      if (fallback) {
        executor = fallback.executor;
        result = fallback.result;
        fallbackReason = `${raceResult.executor.name} 执行失败，已改派 codex-cli 兜底`;
        fallbackLines = [
          `${raceResult.executor.name} 执行失败: ${raceResult.result.error || '未知错误'}`,
          '改派给 codex-cli 兜底执行同一任务，不新建任务',
        ];
      }
    }

    return this.toExecutionResult({
      input,
      executor,
      result,
      workUnitResults: [],
      runtime: {
        raceExecutors: raceExecutors.map(item => item.name),
        abortedExecutors: raceResult.abortedExecutors,
        fallbackReason,
        fallbackLines,
      },
    });
  }

  private async runMultiExecutor(input: ExecutionRuntimeRunInput): Promise<ExecutionResult> {
    if (input.plan.strategy.mode !== 'multi_executor') {
      const fallbackExecutor = this.registry.resolveRequired(input.plan.selectedExecutor);
      const result: ExecutorResult = {
        success: false,
        output: '',
        error: 'multi_executor plan is missing a multi-executor strategy',
        exitCode: 1,
        durationMs: 0,
      };
      return this.toExecutionResult({
        input,
        executor: fallbackExecutor,
        result,
        workUnitResults: [],
        runtime: {
          raceExecutors: [fallbackExecutor.name],
          abortedExecutors: [],
          fallbackReason: null,
          fallbackLines: [],
        },
      });
    }

    const startedAt = Date.now();
    const executors = this.resolveWorkUnitExecutors(input.plan.strategy);
    const loopResult = await this.agenticLoopController.run({
      strategy: input.plan.strategy,
      task: input.executorInput.task,
      userPrompt: input.executorInput.userPrompt,
      executors,
      defaultExecutor: this.defaultExecutor,
      orchestrator: this.multiExecutorOrchestrator,
    });
    const result: ExecutorResult = {
      success: loopResult.status === 'pass',
      output: loopResult.aggregation.finalOutput,
      error: loopResult.status === 'blocked' ? loopResult.blockedReason ?? 'multi-executor verification blocked' : undefined,
      exitCode: loopResult.status === 'pass' ? 0 : 1,
      durationMs: Date.now() - startedAt,
    };

    return this.toExecutionResult({
      input,
      executor: this.defaultExecutor,
      result,
      workUnitResults: loopResult.results,
      runtime: {
        raceExecutors: Array.from(executors.values()).map(item => item.name),
        abortedExecutors: [],
        fallbackReason: null,
        fallbackLines: [],
      },
    });
  }

  private toExecutionResult(input: {
    input: ExecutionRuntimeRunInput;
    executor: ExecutorAdapter;
    result: ExecutorResult;
    workUnitResults: WorkUnitResult[];
    runtime: ExecutionResult['runtime'];
  }): ExecutionResult {
    return {
      taskId: input.input.taskId,
      executionId: input.input.executionId,
      status: input.result.interrupted
        ? 'cancelled'
        : input.result.success ? 'success' : 'failed',
      executorName: input.executor.name,
      output: input.result.output,
      error: input.result.error ?? null,
      artifacts: input.workUnitResults.flatMap(result => result.artifacts),
      workUnitResults: input.workUnitResults,
      durationMs: input.result.durationMs,
      userPrompt: input.input.executorInput.userPrompt,
      preferences: input.input.executorInput.executionContextBundle?.memoryContext.resolvedPreferences ?? [],
      context: input.input.executorInput.executionContextBundle!,
      recovery: {
        recoverable: Boolean(input.result.error),
        blockReason: input.result.error ?? null,
      },
      runtime: input.runtime,
    };
  }

  private resolveWorkUnitExecutors(strategy: Extract<ExecutionStrategy, { mode: 'multi_executor' }>): Map<string, ExecutorAdapter> {
    const executors = new Map<string, ExecutorAdapter>();
    for (const unit of strategy.workUnits) {
      const executor = this.registry.resolve(unit.executorHint);
      if (executor) {
        executors.set(unit.executorHint, executor);
      }
    }
    return executors;
  }

  private resolveRuntimeExecutors(plan: ExecutionPlanV2, selectedExecutor: ExecutorAdapter): ExecutorAdapter[] {
    return [selectedExecutor];
  }


  private async executeWithOptionalRace(
    executors: ExecutorAdapter[],
    input: Omit<ExecutorInput, 'onProgress'>,
    onProgress: (event: ExecutorProgressEvent, executor: ExecutorAdapter) => void,
  ): Promise<ExecutorRaceResult> {
    if (executors.length <= 1) {
      const executor = executors[0] ?? this.defaultExecutor;
      return {
        executor,
        result: await executor.execute({
          ...input,
          onProgress: event => onProgress(event, executor),
        }),
        abortedExecutors: [],
      };
    }

    let settled = false;
    const running = new Set(executors);
    return new Promise<ExecutorRaceResult>((resolve) => {
      for (const executor of executors) {
        executor.execute({
          ...input,
          onProgress: event => onProgress(event, executor),
        }).then((result) => {
          running.delete(executor);
          if (settled) return;

          settled = true;
          const abortedExecutors = this.abortOthers(running, executor);
          resolve({ executor, result, abortedExecutors });
        }).catch((error: Error) => {
          running.delete(executor);
          if (settled) return;

          settled = true;
          const abortedExecutors = this.abortOthers(running, executor);
          resolve({
            executor,
            result: {
              success: false,
              output: '',
              error: error.message,
              exitCode: 1,
              durationMs: 0,
            },
            abortedExecutors,
          });
        });
      }
    });
  }

  private abortOthers(running: Set<ExecutorAdapter>, winner: ExecutorAdapter): string[] {
    return Array.from(running)
      .filter(other => other !== winner)
      .map(other => {
        other.abort();
        return other.name;
      });
  }

  private async executeCodexFallback(input: {
    failedExecutor: ExecutorAdapter;
    failedResult: ExecutorResult;
    executorInput: Omit<ExecutorInput, 'onProgress'>;
    onProgress: (event: ExecutorProgressEvent, executor: ExecutorAdapter) => void;
  }): Promise<ExecutorRaceResult | null> {
    const codexExecutor = this.registry.resolve('codex-cli');
    if (!codexExecutor) {
      return null;
    }

    try {
      const result = await codexExecutor.execute({
        ...input.executorInput,
        onProgress: event => input.onProgress(event, codexExecutor),
      });
      return { executor: codexExecutor, result, abortedExecutors: [] };
    } catch (error) {
      return {
        executor: codexExecutor,
        result: {
          success: false,
          output: '',
          error: (error as Error).message,
          exitCode: 1,
          durationMs: 0,
        },
        abortedExecutors: [],
      };
    }
  }
}
