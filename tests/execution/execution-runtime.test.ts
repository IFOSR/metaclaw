import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ExecutorAdapter, ExecutorInput } from '../../src/executor/adapter.js';
import type { ExecutorResult, Config, Task } from '../../src/core/types.js';
import { ExecutionRuntime, ExecutorAdapterRegistry, ExecutorRegistry } from '../../src/execution/execution-runtime.js';
import type { ExecutionPolicy } from '../../src/core/execution-policy.js';
import { ExecutorProfileRepo } from '../../src/storage/executor-profile-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: { command: 'codex', timeout: 60_000, max_duration: 300 },
    orchestration: { reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5 },
    ui: { language: 'zh-CN', dashboard_on_start: false },
  };
}

function createExecutor(name: string, result: ExecutorResult | Promise<ExecutorResult>): ExecutorAdapter {
  return {
    name,
    execute: vi.fn().mockImplementation(async (_input: ExecutorInput) => result),
    isAvailable: vi.fn().mockResolvedValue(true),
    abort: vi.fn(),
  };
}

function createTask(): Task {
  return {
    id: 'task_runtime',
    title: 'runtime task',
    goal: 'execute runtime task',
    status: 'running',
    summary: '',
    snapshots: [],
    resources: [],
    artifacts: [],
    dependencies: [],
    prioritySignals: {
      dueAt: null,
      isReady: true,
      progressRatio: 0,
      blocksOthers: false,
      idleHours: 0,
    },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: '2026-06-22T00:00:00Z',
    updatedAt: '2026-06-22T00:00:00Z',
  };
}

function createResult(output: string, success = true): ExecutorResult {
  return {
    success,
    output: success ? output : '',
    error: success ? undefined : output,
    exitCode: success ? 0 : 1,
    durationMs: 42,
  };
}

function createPolicy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  const primaryExecutor = overrides.primaryExecutor ?? 'codex-cli';
  return {
    taskId: 'task_runtime',
    mode: 'single_executor',
    primaryExecutor,
    candidateExecutors: [primaryExecutor],
    isolationRequired: false,
    verificationLevel: 'none',
    reviewerExecutor: null,
    riskLevel: 'low',
    estimatedCostClass: 'cheap',
    fallbackChain: [],
    acceptanceCriteria: [],
    capabilityClasses: ['general'],
    reason: 'test policy',
    strategy: {
      mode: 'single_executor',
      reason: 'test strategy',
      subtasks: [],
      aggregation: {
        summary: 'single executor',
        requiredArtifacts: [],
        criteria: [],
      },
    },
    subtasks: [],
    ...overrides,
  };
}

function createExecutorInput(): Omit<ExecutorInput, 'onProgress'> {
  return {
    task: createTask(),
    preferences: [],
    userPrompt: 'execute task',
    conversationHistory: [],
  };
}

function createRuntime(options: {
  defaultExecutor?: ExecutorAdapter;
  executors?: Record<string, ExecutorAdapter>;
  db?: Database.Database;
} = {}): ExecutionRuntime {
  const defaultExecutor = options.defaultExecutor ?? createExecutor('codex-cli', createResult('default ok'));
  const registry = new ExecutorRegistry({
    db: options.db ?? createDb(),
    config: createConfig(),
    defaultExecutor,
    executorFactory: name => options.executors?.[name] ?? null,
  });
  return new ExecutionRuntime(registry, defaultExecutor);
}

describe('ExecutionRuntime', () => {
  it('executes the selected single executor from an execution policy', async () => {
    const deepseek = createExecutor('deepseek-tui', createResult('deepseek ok'));
    const runtime = createRuntime({ executors: { 'deepseek-tui': deepseek } });

    const result = await runtime.run({
      taskId: 'task_runtime',
      executionId: 'exec_runtime',
      policy: createPolicy({
        primaryExecutor: 'deepseek-tui',
        candidateExecutors: ['deepseek-tui'],
      }),
      executorInput: createExecutorInput(),
      onProgress: vi.fn(),
    });

    expect(result.executorName).toBe('deepseek-tui');
    expect(result.output).toBe('deepseek ok');
    expect(result).toMatchObject({
      taskId: 'task_runtime',
      executionId: 'exec_runtime',
      status: 'success',
      executorName: 'deepseek-tui',
      output: 'deepseek ok',
    });
    expect(result.runtime.attemptedExecutors).toEqual(['deepseek-tui']);
    expect(deepseek.execute).toHaveBeenCalledTimes(1);
  });

  it('runs research policies on the primary executor without racing peers', async () => {
    let resolvePi!: (value: ExecutorResult) => void;
    const piPromise = new Promise<ExecutorResult>(resolve => {
      resolvePi = resolve;
    });
    const pi = createExecutor('pi-agent', piPromise);
    const hermes = createExecutor('hermes-agent', createResult('hermes should not run'));
    const runtime = createRuntime({ executors: { 'pi-agent': pi, 'hermes-agent': hermes } });

    const runPromise = runtime.run({
      taskId: 'task_runtime',
      executionId: 'exec_runtime',
      policy: createPolicy({
        mode: 'single_executor',
        primaryExecutor: 'pi-agent',
        candidateExecutors: ['pi-agent', 'hermes-agent'],
      }),
      executorInput: createExecutorInput(),
      onProgress: vi.fn(),
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(pi.execute).toHaveBeenCalledTimes(1);
    expect(hermes.execute).not.toHaveBeenCalled();
    resolvePi(createResult('pi wins'));

    const result = await runPromise;
    expect(result.executorName).toBe('pi-agent');
    expect(result.runtime.attemptedExecutors).toEqual(['pi-agent']);
    expect(hermes.abort).not.toHaveBeenCalled();
  });

  it('uses the policy fallback chain when the primary executor fails', async () => {
    const codex = createExecutor('codex-cli', createResult('codex fallback ok'));
    const pi = createExecutor('pi-agent', createResult('executor idle timeout', false));
    const runtime = createRuntime({
      defaultExecutor: codex,
      executors: { 'pi-agent': pi },
    });

    const result = await runtime.run({
      taskId: 'task_runtime',
      executionId: 'exec_runtime',
      policy: createPolicy({
        primaryExecutor: 'pi-agent',
        candidateExecutors: ['pi-agent'],
        fallbackChain: ['codex-cli'],
      }),
      executorInput: createExecutorInput(),
      onProgress: vi.fn(),
    });

    expect(result.executorName).toBe('codex-cli');
    expect(result.output).toBe('codex fallback ok');
    expect(result.runtime.attemptedExecutors).toEqual(['pi-agent', 'codex-cli']);
    expect(result.runtime.fallbackExecutors).toEqual(['codex-cli']);
    expect(result.runtime.fallbackReason).toBe('pi-agent failed; trying configured fallback chain');
    expect(result.runtime.fallbackLines).toEqual(['pi-agent failed: executor idle timeout']);
    expect(pi.execute).toHaveBeenCalledTimes(1);
    expect(codex.execute).toHaveBeenCalledTimes(1);
  });

  it('runs multi-executor policies through orchestrator and agentic loop with dependency outputs', async () => {
    const hermes = createExecutor('hermes-agent', createResult('research sources: https://example.com docs/research.md'));
    const codex = createExecutor('codex-cli', createResult('implementation used prior research. npm test -- tests/execution/execution-runtime.test.ts docs/patch.md'));
    const runtime = createRuntime({
      defaultExecutor: codex,
      executors: { 'hermes-agent': hermes },
    });

    const result = await runtime.run({
      taskId: 'task_runtime',
      executionId: 'exec_runtime_multi',
      policy: createPolicy({
        mode: 'multi_executor',
        primaryExecutor: 'codex-cli',
        candidateExecutors: ['hermes-agent', 'codex-cli'],
        verificationLevel: 'test',
        strategy: {
          mode: 'multi_executor',
          reason: 'research then implement',
          subtasks: [
            {
              id: 'subtask_research',
              title: 'Research',
              goal: 'Research first',
              executorHint: 'hermes-agent',
              dependsOn: [],
              inputs: { taskId: 'task_runtime', resources: [], recalledTaskIds: [] },
              expectedOutput: 'analysis',
              acceptance: ['include sources'],
              riskLevel: 'medium',
            },
            {
              id: 'subtask_implementation',
              title: 'Implementation',
              goal: 'Implement after research',
              executorHint: 'codex-cli',
              dependsOn: ['subtask_research'],
              inputs: { taskId: 'task_runtime', resources: [], recalledTaskIds: [] },
              expectedOutput: 'patch',
              acceptance: ['include tests'],
              riskLevel: 'high',
            },
          ],
          aggregation: {
            mode: 'verify_and_summarize',
            acceptance: ['include sources', 'include tests'],
            criteria: [],
            conflictPolicy: 'flag_conflicts',
            maxIterations: 1,
          },
        },
      }),
      executorInput: createExecutorInput(),
      onProgress: vi.fn(),
    });

    expect(result.status).toBe('success');
    expect(result.output).toContain('Verification: pass');
    expect(result).toMatchObject({
      taskId: 'task_runtime',
      executionId: 'exec_runtime_multi',
      status: 'success',
      executorName: 'codex-cli',
    });
    expect(result.subtaskResults.map(item => item.subtaskId)).toEqual(['subtask_research', 'subtask_implementation']);
    expect(hermes.execute).toHaveBeenCalledTimes(1);
    expect(codex.execute).toHaveBeenCalledTimes(1);
    const implementationPrompt = (codex.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].userPrompt;
    expect(implementationPrompt).toContain('Previous subtask outputs');
    expect(implementationPrompt).toContain('research sources');
  });

  it('resolves custom executor runtime profiles through the registry', () => {
    const db = createDb();
    new ExecutorProfileRepo(db).upsert({
      name: 'research-bot',
      domains: ['research'],
      capabilities: ['report_generation'],
      inputTypes: ['text'],
      outputTypes: ['markdown'],
      strengths: [],
      weaknesses: [],
      riskLevel: 'medium',
      availability: 'available',
      historicalSuccess: 0.8,
      runtimeCommand: 'research-bot',
      runtimeArgs: ['run', '--prompt', '{prompt}'],
      runtimeCheckCommand: 'research-bot --version',
    });
    const defaultExecutor = createExecutor('codex-cli', createResult('default ok'));
    const registry = new ExecutorRegistry({
      db,
      config: createConfig(),
      defaultExecutor,
    });

    const executor = registry.resolve('research-bot');

    expect(executor?.name).toBe('research-bot');
    expect(executor?.constructor.name).toBe('CustomCliExecutorAdapter');
  });

  it('resolves registered adapter factories without editing runtime branching logic', () => {
    const db = createDb();
    const defaultExecutor = createExecutor('codex-cli', createResult('default ok'));
    const adapterRegistry = new ExecutorAdapterRegistry()
      .register('test-agent', config => createExecutor('test-agent', createResult(`timeout=${config.timeout}`)), ['test']);
    const registry = new ExecutorRegistry({
      db,
      config: createConfig(),
      defaultExecutor,
      adapterRegistry,
    });

    const executor = registry.resolve('test-agent');

    expect(executor?.name).toBe('test-agent');
  });
});
