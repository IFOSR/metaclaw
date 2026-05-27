import { CommandLineExecutorAdapter } from './command-line-adapter.js';

export class DeepSeekTuiAdapter extends CommandLineExecutorAdapter {
  readonly name = 'deepseek-tui';

  protected buildSpawnArgs(prompt: string): string[] {
    return ['exec', '--auto', prompt];
  }
}
