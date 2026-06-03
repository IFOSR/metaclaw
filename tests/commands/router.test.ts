import { describe, expect, it } from 'vitest';
import { CommandRouter } from '../../src/commands/router.js';

describe('CommandRouter', () => {
  it('parses quoted command arguments without splitting embedded spaces', () => {
    const router = new CommandRouter();

    expect(router.parse('/executor register bot --args "run --prompt {prompt}" --check "bot --version"')).toEqual({
      command: 'executor',
      args: ['register', 'bot', '--args', 'run --prompt {prompt}', '--check', 'bot --version'],
    });
  });
});
