import { spawn, spawnSync, type ChildProcess } from 'child_process';
import type { ExecutorAdapter, ExecutorInput } from './adapter.js';
import type { ExecutorResult } from '../core/types.js';
import { buildExecutorContextPrompt } from './prompt-builder.js';
import { formatExecutorError, formatExecutorProgress } from './error-utils.js';

export class ClaudeCodeAdapter implements ExecutorAdapter {
  readonly name = 'claude-code';
  private process: ChildProcess | null = null;
  private abortRequested = false;

  constructor(private config: { command: string; timeout: number; maxDuration?: number; workspaceRoot?: string }) {}

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const contextPrompt = this.buildContextPrompt(input);
    const startTime = Date.now();

    return new Promise((resolve) => {
      this.abortRequested = false;
      input.onProgress?.({ kind: 'status', text: '已启动 claude-code 执行器' });
      this.process = spawn(this.config.command, this.buildSpawnArgs(contextPrompt), {
        cwd: this.config.workspaceRoot ?? process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let idleTimer: NodeJS.Timeout | null = null;
      let maxTimer: NodeJS.Timeout | null = null;
      let forceKillTimer: NodeJS.Timeout | null = null;
      let timeoutReason: 'idle' | 'max' | null = null;

      const idleTimeoutMs = Math.max(this.config.timeout, 1) * 1000;
      const maxDurationSeconds = this.config.maxDuration ?? Math.max(this.config.timeout * 6, 3600);
      const maxDurationMs = Math.max(maxDurationSeconds, this.config.timeout) * 1000;

      const clearTimers = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (maxTimer) clearTimeout(maxTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
      };

      const terminateForTimeout = (reason: 'idle' | 'max') => {
        if (!this.process || this.abortRequested || timeoutReason) {
          return;
        }
        timeoutReason = reason;
        this.process.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
          this.process?.kill('SIGKILL');
        }, 5_000);
      };

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => terminateForTimeout('idle'), idleTimeoutMs);
      };

      maxTimer = setTimeout(() => terminateForTimeout('max'), maxDurationMs);
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
              : timeoutReason === 'max'
                ? 'executor max duration exceeded'
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

  private buildSpawnArgs(prompt: string): string[] {
    return [
      '--print',
      '--dangerously-skip-permissions',
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
