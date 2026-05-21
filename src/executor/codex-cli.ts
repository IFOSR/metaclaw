import { CommandLineExecutorAdapter } from './command-line-adapter.js';

export class CodexCliAdapter extends CommandLineExecutorAdapter {
  readonly name = 'codex-cli';

  protected buildSpawnArgs(prompt: string): string[] {
    return [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      prompt,
    ];
  }
}
