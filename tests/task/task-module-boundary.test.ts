import { existsSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

const taskDomainFiles = [
  'task-engine',
  'task-runtime-service',
  'task-execution-planner',
  'task-resume-planner',
  'task-relevance-ranker',
  'task-semantic-service',
  'task-embedding-service',
  'hybrid-task-retriever',
  'blocked-task-reconciler',
  'scheduler',
];

describe('task module architecture boundaries', () => {
  it('keeps task domain implementations in src/task and out of core', () => {
    for (const file of taskDomainFiles) {
      expect(existsSync(resolve(projectRoot, `src/task/${file}.ts`))).toBe(true);
      expect(existsSync(resolve(projectRoot, `src/core/${file}.ts`))).toBe(false);
    }
  });
});
