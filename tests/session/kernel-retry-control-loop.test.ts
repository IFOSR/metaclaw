import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import type { Config } from '../../src/core/types.js';
import { stubPlanningAgent, workGraphPlan } from '../support/planning-agent-plans.js';
import { FakeAttemptSandbox } from '../support/fake-attempt-sandbox.js';

describe('Kernel durable retry control loop', () => {
  it('rebuilds a due retry wake from the current Kernel decision and completes once', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-kernel-retry');
    const attemptSandbox = new FakeAttemptSandbox((_input, attemptIndex) => attemptIndex === 0
      ? {
          body: 'network unavailable',
          exitCode: 1,
          rawOutput: 'network is unreachable',
        }
      : { body: 'continued successfully' });
    const config: Config = {
      version: 1,
      executor: { command: 'codex', timeout: 60_000 },
      orchestration: {
        max_concurrent_attempts: 4,
        reminder_enabled: false,
        reminder_throttle: 3_600,
        top_k_preferences: 5,
        blocked_recheck_enabled: true,
        blocked_recheck_interval: 5,
      },
      ui: { language: 'zh-CN', dashboard_on_start: false },
    };
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
      orchestration: new OrchestrationEngine(taskEngine),
      attemptSandbox,
      db,
      config,
      sessionId: 'session_retry',
      contextRecaller: new ContextRecaller(db),
      planningAgent: stubPlanningAgent(workGraphPlan({ goal: 'continue after a transient network failure' })),
    });
    session.initialize({ resumeStartupTasks: false, showDashboard: false });

    await session.submit('continue after a transient network failure', { awaitAsyncWork: true });

    const [task] = taskRepo.findAll();
    expect(task.status).toBe('blocked');
    expect(task.dependencies[0]).toMatchObject({ type: 'kernel_retry', status: 'waiting' });
    expect(db.prepare(`SELECT action FROM kernel_decisions WHERE task_id = ? ORDER BY rowid`).all(task.id))
      .toEqual(expect.arrayContaining([{ action: 'wait_for_retry' }]));

    const handled = await session.maybeReviewTaskPoolOnTimer(Date.now() + 60_000);

    expect(handled).toBe(true);
    expect(taskRepo.findById(task.id)?.status).toBe('done');
    expect(attemptSandbox.create).toHaveBeenCalledTimes(2);
    const retryPrompt = attemptSandbox.create.mock.calls[1]![0].args.at(-1);
    expect(retryPrompt).toContain('Recovery mode: recovery_packet');
    expect(retryPrompt).toContain('Recovery packet:');
    expect(retryPrompt).toContain('执行器网络连接失败，请检查网络或代理配置');
    expect(db.prepare(`
      SELECT attempt_kind, source_attempt_id FROM executor_attempt_receipts
      WHERE task_id = ? ORDER BY completed_at, attempt_id
    `).all(task.id)).toEqual([
      { attempt_kind: 'primary', source_attempt_id: null },
      expect.objectContaining({ attempt_kind: 'continuation', source_attempt_id: expect.any(String) }),
    ]);
  });
});
