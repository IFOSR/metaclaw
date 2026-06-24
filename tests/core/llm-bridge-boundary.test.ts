import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

function readSource(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf-8');
}

describe('LlmBridge legacy boundaries', () => {
  it('marks legacy schemas and methods as deprecated compatibility, not the natural-language main path', () => {
    const source = readSource('src/core/llm-bridge.ts');

    expect(source).toMatch(/@deprecated[\s\S]{0,300}export interface IntentResult/);
    expect(source).toMatch(/@deprecated[\s\S]{0,300}export interface TaskResumeIntentResult/);
    expect(source).toMatch(/@deprecated[\s\S]{0,300}export interface RouteResult/);
    expect(source).toMatch(/@deprecated[\s\S]{0,300}export type IntentDecisionResult/);
    expect(source).toMatch(/@deprecated[\s\S]{0,400}resolveIntent\(/);
    expect(source).toMatch(/@deprecated[\s\S]{0,400}resolveTaskResumeIntent/);
    expect(source).toMatch(/@deprecated[\s\S]{0,400}resolveRoute/);
    expect(source).toMatch(/@deprecated[\s\S]{0,400}resolveIntentDecision/);
    expect(source).toMatch(/@deprecated[\s\S]{0,400}resolveTaskStateOwnership/);
  });
});
