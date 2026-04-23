import { EventEmitter } from 'events';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  kill() {
    this.emit('close', null);
    return true;
  }
}

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn().mockReturnValue({ status: 0 });

vi.mock('child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

describe('executor interruption semantics', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks codex execution as interrupted after abort', async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { CodexCliAdapter } = await import('../../src/executor/codex-cli.js');
    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 300 });

    const resultPromise = adapter.execute({
      task: {
        id: 'task_1',
        title: '测试任务',
        goal: '测试目标',
        status: 'running',
        summary: '',
        snapshots: [],
        resources: [],
        dependencies: [],
        prioritySignals: {
          dueAt: null,
          isReady: true,
          progressRatio: 0,
          blocksOthers: false,
          idleHours: 0,
        },
        injectedPreferences: [],
        lastSchedulingReason: '',
        lastInterruptionReason: '',
        interruptionCount: 0,
        createdAt: '2026-04-16T00:00:00Z',
        updatedAt: '2026-04-16T00:00:00Z',
      },
      preferences: [],
      userPrompt: '继续',
      conversationHistory: [],
    });

    adapter.abort();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.interrupted).toBe(true);
    expect(result.error).toContain('interrupted');
  });

  it('marks claude execution as interrupted after abort', async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { ClaudeCodeAdapter } = await import('../../src/executor/claude-code.js');
    const adapter = new ClaudeCodeAdapter({ command: 'claude', timeout: 300 });

    const resultPromise = adapter.execute({
      task: {
        id: 'task_1',
        title: '测试任务',
        goal: '测试目标',
        status: 'running',
        summary: '',
        snapshots: [],
        resources: [],
        dependencies: [],
        prioritySignals: {
          dueAt: null,
          isReady: true,
          progressRatio: 0,
          blocksOthers: false,
          idleHours: 0,
        },
        injectedPreferences: [],
        lastSchedulingReason: '',
        lastInterruptionReason: '',
        interruptionCount: 0,
        createdAt: '2026-04-16T00:00:00Z',
        updatedAt: '2026-04-16T00:00:00Z',
      },
      preferences: [],
      userPrompt: '继续',
      conversationHistory: [],
    });

    adapter.abort();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.interrupted).toBe(true);
    expect(result.error).toContain('interrupted');
  });

  it('does not time out while codex keeps producing activity', async () => {
    vi.useFakeTimers();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { CodexCliAdapter } = await import('../../src/executor/codex-cli.js');
    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 1, maxDuration: 10 });

    const resultPromise = adapter.execute({
      task: {
        id: 'task_1',
        title: '测试任务',
        goal: '测试目标',
        status: 'running',
        summary: '',
        snapshots: [],
        resources: [],
        dependencies: [],
        prioritySignals: {
          dueAt: null,
          isReady: true,
          progressRatio: 0,
          blocksOthers: false,
          idleHours: 0,
        },
        injectedPreferences: [],
        lastSchedulingReason: '',
        lastInterruptionReason: '',
        interruptionCount: 0,
        createdAt: '2026-04-16T00:00:00Z',
        updatedAt: '2026-04-16T00:00:00Z',
      },
      preferences: [],
      userPrompt: '继续',
      conversationHistory: [],
    });

    await vi.advanceTimersByTimeAsync(900);
    child.stdout.emit('data', Buffer.from('working\n'));
    await vi.advanceTimersByTimeAsync(900);
    child.stderr.emit('data', Buffer.from('still running\n'));
    await vi.advanceTimersByTimeAsync(900);
    child.emit('close', 0);

    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('working');
  });

  it('marks codex execution as failed after prolonged inactivity', async () => {
    vi.useFakeTimers();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { CodexCliAdapter } = await import('../../src/executor/codex-cli.js');
    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 1, maxDuration: 10 });

    const resultPromise = adapter.execute({
      task: {
        id: 'task_1',
        title: '测试任务',
        goal: '测试目标',
        status: 'running',
        summary: '',
        snapshots: [],
        resources: [],
        dependencies: [],
        prioritySignals: {
          dueAt: null,
          isReady: true,
          progressRatio: 0,
          blocksOthers: false,
          idleHours: 0,
        },
        injectedPreferences: [],
        lastSchedulingReason: '',
        lastInterruptionReason: '',
        interruptionCount: 0,
        createdAt: '2026-04-16T00:00:00Z',
        updatedAt: '2026-04-16T00:00:00Z',
      },
      preferences: [],
      userPrompt: '继续',
      conversationHistory: [],
    });

    await vi.advanceTimersByTimeAsync(1001);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.interrupted).toBeFalsy();
    expect(result.error).toContain('idle timeout');
  });
});
