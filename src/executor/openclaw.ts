import { CommandLineExecutorAdapter } from './command-line-adapter.js';

export class OpenClawAdapter extends CommandLineExecutorAdapter {
  readonly name = 'openclaw';

  protected buildSpawnArgs(prompt: string): string[] {
    return ['agent', '--message', prompt, '--local', '--json'];
  }
}
