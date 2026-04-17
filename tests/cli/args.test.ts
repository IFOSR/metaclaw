import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../src/cli/args.js';

describe('parseCliArgs', () => {
  it('parses script mode from argv', () => {
    expect(parseCliArgs(['--script', '/tmp/metaclaw-flow.txt'])).toEqual({
      scriptPath: '/tmp/metaclaw-flow.txt',
    });
  });

  it('returns empty options when no script mode is requested', () => {
    expect(parseCliArgs([])).toEqual({});
  });
});
