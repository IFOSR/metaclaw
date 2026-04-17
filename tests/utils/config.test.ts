import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/utils/config.js';

describe('loadConfig defaults', () => {
  it('uses codex as the default executor command', () => {
    const config = loadConfig('/path/that/does/not/exist.yaml');

    expect(config.executor.command).toBe('codex');
  });
});
