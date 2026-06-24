import { CommandLineExecutorAdapter } from './command-line-adapter.js';
import { buildCodexNonInteractiveArgs } from './codex-args.js';

export class CodexCliAdapter extends CommandLineExecutorAdapter {
  readonly name = 'codex-cli';

  protected buildSpawnArgs(prompt: string): string[] {
    return buildCodexNonInteractiveArgs(prompt);
  }
}
