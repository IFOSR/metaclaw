import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

function readSource(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf-8');
}

describe('Execution runtime architecture boundaries', () => {
  it('keeps executor creation and race runtime out of MetaclawSession', () => {
    const sessionSource = readSource('src/session/metaclaw-session.ts');
    const coordinatorSource = readSource('src/session/session-execution-coordinator.ts');
    const executionApplicationSource = readSource('src/session/session-task-execution-application-service.ts');

    expect(sessionSource).toContain('SessionTaskExecutionApplicationService');
    expect(executionApplicationSource).toContain('sessionExecutionCoordinator.execute');
    expect(sessionSource).not.toContain('executionRuntime.run');
    expect(coordinatorSource).toContain('executionRuntime.run');
    expect(sessionSource).not.toContain('executeWithOptionalRace');
    expect(sessionSource).not.toContain('executeCodexFallbackOnFailure');
    expect(sessionSource).not.toContain('createExecutorForRoute');
    expect(sessionSource).not.toContain('resolveRaceExecutors');
    expect(sessionSource).not.toContain('new CustomCliExecutorAdapter');
    expect(sessionSource).not.toContain('createExecutorByName');
  });

  it('centralizes executor registry and policy fallback behavior in ExecutionRuntime', () => {
    const runtimeSource = readSource('src/execution/execution-runtime.ts');

    expect(runtimeSource).toContain('export class ExecutorAdapterRegistry');
    expect(runtimeSource).toContain('export class ExecutorRegistry');
    expect(runtimeSource).toContain('new CustomCliExecutorAdapter');
    expect(runtimeSource).not.toContain('createExecutorByName');
    expect(runtimeSource).not.toContain('const adapterFactories');
    expect(runtimeSource).not.toContain('executeWithOptionalRace');
    expect(runtimeSource).not.toContain('executeCodexFallback');
    expect(runtimeSource).toContain('executeWithFallbackChain');
    expect(runtimeSource).toContain('input.policy.fallbackChain');
    expect(runtimeSource).not.toContain("plan.mode !== 'race_executors'");
  });

  it('routes complex execution through multi-executor orchestration and agentic loop in ExecutionRuntime', () => {
    const runtimeSource = readSource('src/execution/execution-runtime.ts');

    expect(runtimeSource).toContain('MultiExecutorOrchestrator');
    expect(runtimeSource).toContain('AgenticLoopController');
    expect(runtimeSource).toContain("input.policy.mode === 'multi_executor'");
    expect(runtimeSource).toContain('agenticLoopController.run');
  });

  it('exposes the standard ExecutionResult contract to the session execution path', () => {
    const sessionSource = readSource('src/session/metaclaw-session.ts');
    const coordinatorSource = readSource('src/session/session-execution-coordinator.ts');
    const runtimeSource = readSource('src/execution/execution-runtime.ts');

    expect(runtimeSource).toContain('Promise<ExecutionResult>');
    expect(runtimeSource).toContain('toExecutionResult');
    expect(coordinatorSource).toContain('const execution = await this.deps.executionRuntime.run');
    expect(sessionSource).not.toContain('const execution = await this.executionRuntime.run');
    expect(sessionSource).not.toContain('runtimeResult.execution');
    expect(sessionSource).not.toContain('runtimeResult.executor');
    expect(sessionSource).not.toContain('runtimeResult.result');
    expect(sessionSource).not.toContain('runtimeResult.fallbackLines');
    expect(sessionSource).not.toContain('runtimeResult.result');
  });
});
