import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ExecutorAdapter, ExecutorInput } from '../../src/executor/adapter.js';
import type { ExecutorResult, Config, Task } from '../../src/core/types.js';
import { ExecutionRuntime, ExecutorAdapterRegistry, ExecutorRegistry } from '../../src/core/execution-runtime.js';
import type { ExecutionPlanV2 } from '../../src/core/execution-planning-service.js';
import type { ExecutorRouteDecision } from '../../src/core/executor-router.js';
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
    title: '运行时任务',
    goal: '执行运行时任务',
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

function createRouteDecision(overrides: Partial<ExecutorRouteDecision> = {}): ExecutorRouteDecision {
  return {
    selectedExecutor: 'codex-cli',
    action: 'auto_dispatch',
    candidates: [{ executorName: 'codex-cli', score: 1, matched: ['general'], missing: [] }],
    primaryIntent: 'general',
    matchedBoundary: ['general'],
    rejected: [],
    confidence: 0.9,
    reason: 'test route',
    ...overrides,
  };
}

function createPlan(overrides: Partial<ExecutionPlanV2> = {}): ExecutionPlanV2 {
  const routeDecision = overrides.routeDecision ?? createRouteDecision({
    selectedExecutor: overrides.selectedExecutor ?? 'codex-cli',
    candidates: (overrides.candidateExecutors ?? [overrides.selectedExecutor ?? 'codex-cli']).map(executorName => ({
      executorName,
      score: 1,
      matched: ['general'],
      missing: [],
    })),
  });

  return {
    taskId: 'task_runtime',
    mode: 'single_executor',
    reason: 'test plan',
    selectedExecutor: 'codex-cli',
    candidateExecutors: ['codex-cli'],
    routeDecision,
    strategy: {
      mode: 'single_executor',
      reason: 'test strategy',
      workUnits: [],
      aggregation: {
        summary: 'single executor',
        requiredArtifacts: [],
        criteria: [],
      },
    },
    workUnits: [],
    acceptanceCriteria: [],
    requiresVerification: false,
    ...overrides,
  };
}

function createExecutorInput(): Omit<ExecutorInput, 'onProgress'> {
  return {
    task: createTask(),
    preferences: [],
    userPrompt: '执行任务',
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
  it('executes the selected single executor from an execution plan', async () => {
    const deepseek = createExecutor('deepseek-tui', createResult('deepseek ok'));
    const runtime = createRuntime({ executors: { 'deepseek-tui': deepseek } });

    const result = await runtime.run({
      taskId: 'task_runtime',
      executionId: 'exec_runtime',
      plan: createPlan({
        selectedExecutor: 'deepseek-tui',
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
    expect(result.runtime.raceExecutors).toEqual(['deepseek-tui']);
    expect(deepseek.execute).toHaveBeenCalledTimes(1);
  });

  it('races research executors and aborts slower executors', async () => {
    let resolvePi!: (value: ExecutorResult) => void;
    const piPromise = new Promise<ExecutorResult>(resolve => {
      resolvePi = resolve;
    });
    const pi = createExecutor('pi-agent', piPromise);
    const hermes = createExecutor('hermes-agent', new Promise<ExecutorResult>(() => {}));
    const runtime = createRuntime({ executors: { 'pi-agent': pi, 'hermes-agent': hermes } });

    const runPromise = runtime.run({
      taskId: 'task_runtime',
      executionId: 'exec_runtime',
      plan: createPlan({
        mode: 'single_executor',
        selectedExecutor: 'pi-agent',
        candidateExecutors: ['pi-agent', 'hermes-agent'],
        routeDecision: createRouteDecision({
          selectedExecutor: 'pi-agent',
          primaryIntent: 'research_workflow',
          matchedBoundary: ['research'],
        }),
      }),
      executorInput: createExecutorInput(),
      onProgress: vi.fn(),
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(pi.execute).toHaveBeenCalledTimes(1);
    expect(hermes.execute).toHaveBeenCalledTimes(1);
    resolvePi(createResult('pi wins'));

    const result = await runPromise;
    expect(result.executorName).toBe('pi-agent');
    expect(result.runtime.abortedExecutors).toEqual(['hermes-agent']);
    expect(hermes.abort).toHaveBeenCalledTimes(1);
  });

  it('falls back to codex-cli when a non-Codex executor fails', async () => {
    const codex = createExecutor('codex-cli', createResult('codex fallback ok'));
    const pi = createExecutor('pi-agent', createResult('executor idle timeout', false));
    const runtime = createRuntime({
      defaultExecutor: codex,
      executors: { 'pi-agent': pi },
    });

    const result = await runtime.run({
      taskId: 'task_runtime',
      executionId: 'exec_runtime',
      plan: createPlan({
        selectedExecutor: 'pi-agent',
        candidateExecutors: ['pi-agent'],
      }),
      executorInput: createExecutorInput(),
      onProgress: vi.fn(),
    });

    expect(result.executorName).toBe('codex-cli');
    expect(result.output).toBe('codex fallback ok');
    expect(result.runtime.fallbackReason).toBe('pi-agent 执行失败，已改派 codex-cli 兜底');
    expect(result.runtime.fallbackLines).toEqual([
      'pi-agent 执行失败: executor idle timeout',
      '改派给 codex-cli 兜底执行同一任务，不新建任务',
    ]);
    expect(pi.execute).toHaveBeenCalledTimes(1);
    expect(codex.execute).toHaveBeenCalledTimes(1);
  });

  it('runs multi-executor plans through orchestrator and agentic loop with dependency outputs', async () => {
    const hermes = createExecutor('hermes-agent', createResult('research sources: https://example.com docs/research.md'));
    const codex = createExecutor('codex-cli', createResult('implementation used prior research. npm test -- tests/core/execution-runtime.test.ts docs/patch.md'));
    const runtime = createRuntime({
      defaultExecutor: codex,
      executors: { 'hermes-agent': hermes },
    });

    const result = await runtime.run({
      taskId: 'task_runtime',
      executionId: 'exec_runtime_multi',
      plan: createPlan({
        mode: 'multi_executor',
        selectedExecutor: 'codex-cli',
        candidateExecutors: ['hermes-agent', 'codex-cli'],
        strategy: {
          mode: 'multi_executor',
          reason: 'research then implement',
          workUnits: [
            {
              id: 'wu_research',
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
              id: 'wu_implementation',
              title: 'Implementation',
              goal: 'Implement after research',
              executorHint: 'codex-cli',
              dependsOn: ['wu_research'],
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
        workUnits: [],
        acceptanceCriteria: [],
        requiresVerification: true,
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
    expect(result.workUnitResults.map(item => item.workUnitId)).toEqual(['wu_research', 'wu_implementation']);
    expect(hermes.execute).toHaveBeenCalledTimes(1);
    expect(codex.execute).toHaveBeenCalledTimes(1);
    const implementationPrompt = (codex.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].userPrompt;
    expect(implementationPrompt).toContain('Previous work unit outputs');
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
