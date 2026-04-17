import { describe, expect, it } from 'vitest';
import { helpCommand } from '../../src/commands/global-commands.js';

describe('global commands', () => {
  it('includes /history and /config in help output', async () => {
    const result = await helpCommand.execute([], {} as any);

    expect(result.content).toContain('/history');
    expect(result.content).toContain('/config');
  });
});
