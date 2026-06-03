import { spawnSync } from 'child_process';
import { CommandLineExecutorAdapter } from './command-line-adapter.js';

export interface CustomCliExecutorConfig {
  name: string;
  command: string;
  args: string[];
  checkCommand?: string | null;
  timeout: number;
  maxDuration?: number;
  workspaceRoot?: string;
}

export class CustomCliExecutorAdapter extends CommandLineExecutorAdapter {
  readonly name: string;

  constructor(private customConfig: CustomCliExecutorConfig) {
    super(customConfig);
    this.name = customConfig.name;
  }

  protected buildSpawnArgs(prompt: string): string[] {
    if (this.customConfig.args.some(arg => arg.includes('{prompt}'))) {
      return this.customConfig.args.map(arg => arg.replaceAll('{prompt}', prompt));
    }

    return [...this.customConfig.args, prompt];
  }

  async isAvailable(): Promise<boolean> {
    if (!this.customConfig.checkCommand) {
      return super.isAvailable();
    }

    try {
      const result = spawnSync(this.customConfig.checkCommand, {
        cwd: this.customConfig.workspaceRoot ?? process.cwd(),
        shell: true,
        stdio: 'ignore',
        timeout: 10_000,
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }
}
