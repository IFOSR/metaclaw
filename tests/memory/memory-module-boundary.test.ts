import { existsSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

const MEMORY_FILES = [
  'memory-engine',
  'memory-capture-service',
  'memory-context-service',
  'memory-vault-exporter',
  'hybrid-memory-recaller',
  'context-recaller',
  'resume-context-builder',
  'recall-policy-service',
  'recall-review-application-service',
  'recall-review-builder',
  'preference-embedding-service',
];

describe('memory module architecture boundaries', () => {
  it('keeps the memory domain implementation in src/memory and out of core', () => {
    for (const file of MEMORY_FILES) {
      expect(existsSync(resolve(projectRoot, `src/memory/${file}.ts`))).toBe(true);
      expect(existsSync(resolve(projectRoot, `src/core/${file}.ts`))).toBe(false);
    }
  });
});
