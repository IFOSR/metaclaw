import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

function readSource(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf-8');
}

describe('Memory context architecture boundaries', () => {
  it('keeps MetaclawSession behind MemoryContextService for recall and execution context building', () => {
    const source = readSource('src/session/metaclaw-session.ts');
    const coordinatorSource = readSource('src/session/session-execution-coordinator.ts');

    expect(source).not.toContain('memoryEngine.recall(');
    expect(source).not.toContain('memoryEngine.recallForReview(');
    expect(source).not.toContain('contextRecaller.recallAsync(');
    expect(source).not.toContain('resumeContextBuilder.build(');
    expect(source).toContain('MemoryContextService');
    expect(source).not.toContain('memoryContextService.prepareExecutionContext');
    expect(coordinatorSource).toContain('memoryContextService.prepareExecutionContext');
  });

  it('keeps MemoryContextService out of intent routing and executor selection', () => {
    const source = readSource('src/memory/memory-context-service.ts');

    expect(source).not.toContain('IntentOrchestrator');
    expect(source).not.toContain('ExecutorRouter');
    expect(source).not.toContain('createExecutor');
  });

  it('defines ExecutionContextBundleV2 as the execution context contract', () => {
    const typesSource = readSource('src/core/types.ts');
    const planningSource = readSource('src/core/execution-planning-service.ts');

    expect(typesSource).toContain('export interface ExecutionContextBundleV2');
    expect(typesSource).toContain('export type ExecutionContextBundle = ExecutionContextBundleV2');
    expect(planningSource).toContain('ExecutionContextBundleV2');
    expect(planningSource).toContain('context: ExecutionContextBundleV2');
  });
});
