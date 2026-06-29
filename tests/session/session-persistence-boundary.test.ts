import { existsSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

describe('session persistence module architecture boundaries', () => {
  it('keeps SessionPersistenceService in src/session and out of core', () => {
    expect(existsSync(resolve(projectRoot, 'src/session/session-persistence-service.ts'))).toBe(true);
    expect(existsSync(resolve(projectRoot, 'src/core/session-persistence-service.ts'))).toBe(false);
  });
});
