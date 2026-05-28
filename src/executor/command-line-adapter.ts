import { spawn, spawnSync, type ChildProcess } from 'child_process';
import type { ExecutorAdapter, ExecutorInput } from './adapter.js';
import type { ExecutorResult } from '../core/types.js';
import { buildExecutorContextPrompt } from './prompt-builder.js';
import { formatExecutorError, formatExecutorProgress } from './error-utils.js';

export abstract class CommandLineExecutorAdapter implements ExecutorAdapter {
  abstract readonly name: string;
  private process: ChildProcess | null = null;
  private abortRequested = false;

  constructor(protected config: { command: string; timeout: number; maxDuration?: number; workspaceRoot?: string }) {}

  protected abstract buildSpawnArgs(prompt: string): string[];

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const contextPrompt = this.buildContextPrompt(input);
    const startTime = Date.now();

    return new Promise((resolve) => {
      this.abortRequested = false;
      input.onProgress?.({ kind: 'status', text: `已启动 ${this.name} 执行器` });
      this.process = spawn(this.config.command, this.buildSpawnArgs(contextPrompt), {
        cwd: this.config.workspaceRoot ?? process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let idleTimer: NodeJS.Timeout | null = null;
      let forceKillTimer: NodeJS.Timeout | null = null;
      let timeoutReason: 'idle' | null = null;

      const idleTimeoutMs = Math.max(this.config.timeout, 1) * 1000;

      const clearTimers = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
      };

      const terminateForIdleTimeout = () => {
        if (!this.process || this.abortRequested || timeoutReason) {
          return;
        }
        timeoutReason = 'idle';
        this.process.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
          this.process?.kill('SIGKILL');
        }, 5_000);
      };

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(terminateForIdleTimeout, idleTimeoutMs);
      };

      resetIdleTimer();

      this.process.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        resetIdleTimer();
        stdoutBuffer = this.emitProgressLines(stdoutBuffer + text, input);
      });
      this.process.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        resetIdleTimer();
        stderrBuffer = this.emitProgressLines(stderrBuffer + text, input);
      });

      this.process.on('close', (code) => {
        clearTimers();
        this.flushProgressBuffer(stdoutBuffer, input);
        this.flushProgressBuffer(stderrBuffer, input);
        const interrupted = this.abortRequested;
        const success = !interrupted && !timeoutReason && code === 0;
        const error = success
          ? undefined
          : interrupted
            ? 'execution interrupted'
            : timeoutReason === 'idle'
              ? 'executor idle timeout'
              : formatExecutorError(stderr);
        resolve({
          success,
          output: stdout.trim(),
          error,
          exitCode: code ?? 1,
          durationMs: Date.now() - startTime,
          interrupted,
        });
        this.process = null;
        this.abortRequested = false;
      });

      this.process.on('error', (err) => {
        clearTimers();
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

  protected buildContextPrompt(input: ExecutorInput): string {
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
