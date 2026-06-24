import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

function readSource(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf-8');
}

describe('executor factory architecture boundaries', () => {
  it('marks the legacy executor factory as deprecated compatibility code', () => {
    const source = readSource('src/executor/factory.ts');

    expect(source).toMatch(/@deprecated[\s\S]{0,300}createExecutor\(/);
    expect(source).toMatch(/@deprecated[\s\S]{0,300}createExecutorByName/);
  });

  it('keeps production entrypoints off the legacy executor factory', () => {
    expect(readSource('src/index.ts')).not.toContain("from './executor/factory.js'");
    expect(readSource('src/gateway/server.ts')).not.toContain("from '../executor/factory.js'");
  });

  it('keeps legacy factory imports out of core runtime and session paths', () => {
    expect(readSource('src/core/execution-runtime.ts')).not.toContain("from '../executor/factory.js'");
    expect(readSource('src/session/metaclaw-session.ts')).not.toContain("from '../executor/factory.js'");
  });
});
