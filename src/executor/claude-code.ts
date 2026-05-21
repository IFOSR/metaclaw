import { CommandLineExecutorAdapter } from './command-line-adapter.js';

export class ClaudeCodeAdapter extends CommandLineExecutorAdapter {
  readonly name = 'claude-code';

  protected buildSpawnArgs(prompt: string): string[] {
    return [
      '--print',
      '--dangerously-skip-permissions',
      prompt,
    ];
  }
}
