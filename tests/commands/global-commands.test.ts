import { describe, it, expect } from 'vitest';
import { exitCommand } from '../../src/commands/global-commands.js';

describe('exitCommand', () => {
  it('应返回 exit 类型', async () => {
    const result = await exitCommand.execute([], {} as any);
    expect(result.type).toBe('exit');
  });

  it('名称为 exit，别名包含 quit 和 q', () => {
    expect(exitCommand.name).toBe('exit');
    expect(exitCommand.aliases).toContain('quit');
    expect(exitCommand.aliases).toContain('q');
  });
});
