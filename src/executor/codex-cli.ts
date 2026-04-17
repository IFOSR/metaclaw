import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { tmpdir } from 'os';
import type { ExecutorAdapter, ExecutorInput } from './adapter.js';
import type { ExecutorResult } from '../core/types.js';
import { buildExecutorContextPrompt } from './prompt-builder.js';
import { formatExecutorError } from './error-utils.js';

export class CodexCliAdapter implements ExecutorAdapter {
  readonly name = 'codex-cli';
  private process: ChildProcess | null = null;
  private abortRequested = false;

  constructor(private config: { command: string; timeout: number }) {}

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const contextPrompt = this.buildContextPrompt(input);
    const startTime = Date.now();

    return new Promise((resolve) => {
      this.abortRequested = false;
      this.process = spawn(this.config.command, this.buildSpawnArgs(contextPrompt), {
        cwd: tmpdir(),
        timeout: this.config.timeout * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      this.process.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      this.process.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      this.process.on('close', (code) => {
        const interrupted = this.abortRequested;
        resolve({
          success: !interrupted && code === 0,
          output: stdout.trim(),
          error: interrupted ? 'execution interrupted' : formatExecutorError(stderr),
          exitCode: code ?? 1,
          durationMs: Date.now() - startTime,
          interrupted,
        });
        this.process = null;
        this.abortRequested = false;
      });

      this.process.on('error', (err) => {
        resolve({
          success: false,
          output: '',
          error: formatExecutorError(err.message) ?? err.message,
          exitCode: 1,
          durationMs: Date.now() - startTime,
        });
        this.process = null;
        this.abortRequested = false;
      });
    });
  }

  private buildSpawnArgs(prompt: string): string[] {
    return [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      prompt,
    ];
  }

  private buildContextPrompt(input: ExecutorInput): string {
    return buildExecutorContextPrompt(input);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = spawnSync('which', [this.config.command]);
      return result.status === 0;
    } catch {
      return false;
    }
  }

  abort(): void {
    this.abortRequested = true;
    this.process?.kill('SIGTERM');
  }
}
