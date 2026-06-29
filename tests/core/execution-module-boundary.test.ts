import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

function readSource(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf-8');
}

function coreFileExists(path: string): boolean {
  return existsSync(resolve(projectRoot, path));
}

describe('execution module architecture boundaries', () => {
  it('keeps execution aggregation implementation in src/execution and out of core', () => {
    const implementationSource = readSource('src/execution/execution-aggregator.ts');

    expect(implementationSource).toContain('export class ExecutionAggregator');
    expect(implementationSource).toContain('export interface ExecutionAggregationInput');
    expect(coreFileExists('src/core/execution-aggregator.ts')).toBe(false);
  });

  it('keeps execution progress tracking implementation in src/execution and out of core', () => {
    const implementationSource = readSource('src/execution/execution-progress-service.ts');

    expect(implementationSource).toContain('export class ExecutionProgressService');
    expect(implementationSource).toContain('export interface ExecutionProgressTracker');
    expect(coreFileExists('src/core/execution-progress-service.ts')).toBe(false);
  });

  it('keeps workspace target preparation implementation in src/execution and out of core', () => {
    const implementationSource = readSource('src/execution/workspace-target-service.ts');

    expect(implementationSource).toContain('export class WorkspaceTargetService');
    expect(coreFileExists('src/core/workspace-target-service.ts')).toBe(false);
  });
});
