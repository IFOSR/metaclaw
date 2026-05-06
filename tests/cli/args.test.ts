import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../src/cli/args.js';

describe('parseCliArgs', () => {
  it('parses script mode from argv', () => {
    expect(parseCliArgs(['--script', '/tmp/metaclaw-flow.txt'])).toEqual({
      scriptPath: '/tmp/metaclaw-flow.txt',
      gateway: false,
      connect: false,
    });
  });

  it('returns empty options when no script mode is requested', () => {
    expect(parseCliArgs([])).toEqual({
      gateway: false,
      connect: false,
    });
  });

  it('parses gateway and connect modes from argv', () => {
    expect(parseCliArgs(['--gateway'])).toEqual({
      gateway: true,
      connect: false,
    });
    expect(parseCliArgs(['--connect'])).toEqual({
      gateway: false,
      connect: true,
    });
  });
});
