import { CommandLineExecutorAdapter } from './command-line-adapter.js';

export class HermesAgentAdapter extends CommandLineExecutorAdapter {
  readonly name = 'hermes-agent';

  protected buildSpawnArgs(prompt: string): string[] {
    return ['chat', '-q', prompt, '-Q'];
  }
}
