import { spawn, spawnSync, type ChildProcess } from 'child_process';
import type { ExecutorAdapter, ExecutorInput } from './adapter.js';
import type { ExecutorResult } from '../core/types.js';
import { buildExecutorContextPrompt } from './prompt-builder.js';
import { formatExecutorError, formatExecutorProgress } from './error-utils.js';

export class CodexCliAdapter implements ExecutorAdapter {
  readonly name = 'codex-cli';
  private process: ChildProcess | null = null;
  private abortRequested = false;

  constructor(private config: { command: string; timeout: number; workspaceRoot?: string }) {}

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const contextPrompt = this.buildContextPrompt(input);
    const startTime = Date.now();

    return new Promise((resolve) => {
      this.abortRequested = false;
      input.onProgress?.({ kind: 'status', text: '已启动 codex-cli 执行器' });
      this.process = spawn(this.config.command, this.buildSpawnArgs(contextPrompt), {
        cwd: this.config.workspaceRoot ?? process.cwd(),
        timeout: this.config.timeout * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let stdoutBuffer = '';
      let stderrBuffer = '';

      this.process.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        stdoutBuffer = this.emitProgressLines(stdoutBuffer + text, input);
      });
      this.process.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        stderrBuffer = this.emitProgressLines(stderrBuffer + text, input);
      });

      this.process.on('close', (code) => {
        this.flushProgressBuffer(stdoutBuffer, input);
        this.flushProgressBuffer(stderrBuffer, input);
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

  private emitProgressLines(buffer: string, input: ExecutorInput): string {
    const lines = buffer.split(/\r?\n/);
    const pending = lines.pop() ?? '';

    for (const line of lines) {
      const progress = formatExecutorProgress(line);
      if (progress) {
        input.onProgress?.({ kind: 'log', text: progress });
      }
    }

    return pending;
  }

  private flushProgressBuffer(buffer: string, input: ExecutorInput): void {
    const progress = formatExecutorProgress(buffer);
    if (progress) {
      input.onProgress?.({ kind: 'log', text: progress });
    }
  }
}
