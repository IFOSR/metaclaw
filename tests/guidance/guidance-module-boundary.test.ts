import { existsSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

const guidanceFiles = [
  'orchestration',
  'guidance-policy-engine',
  'task-signal-service',
];

describe('guidance module architecture boundaries', () => {
  it('keeps guidance implementations outside core', () => {
    for (const file of guidanceFiles) {
      expect(existsSync(resolve(projectRoot, `src/guidance/${file}.ts`))).toBe(true);
      expect(existsSync(resolve(projectRoot, `src/core/${file}.ts`))).toBe(false);
    }
  });
});
