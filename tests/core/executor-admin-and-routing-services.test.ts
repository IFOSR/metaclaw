import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { ExecutorAdminService } from '../../src/executor/executor-admin-service.js';
import { ExecutorProfileService } from '../../src/executor/executor-profile-service.js';
import { SessionPresentationService } from '../../src/session/session-presentation-service.js';
import { SessionPersistenceService } from '../../src/core/session-persistence-service.js';
import { ExecutorRoutingCoordinator } from '../../src/core/executor-routing-coordinator.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createTaskRuntime(db: Database.Database) {
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-admin-routing-tests');
  const executor: ExecutorAdapter = {
    name: 'codex-cli',
    execute: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    abort: vi.fn(),
  };
  return {
    executor,
    taskRuntimeService: new TaskRuntimeService({
      taskEngine,
      taskRepo,
      orchestration: new OrchestrationEngine(taskEngine),
    }),
  };
}

describe('executor admin and routing services', () => {
  it('owns executor register wizard state and persists profiles without session logic', async () => {
    const db = createDb();
    const profileService = new ExecutorProfileService({
      db,
      defaultExecutorName: 'codex-cli',
    });
    const service = new ExecutorAdminService({
      profileService,
      presentation: new SessionPresentationService(),
      fetchText: vi.fn(),
    });

    expect(service.startWizard().join('\n')).toContain('Executor 名称是什么');
    await service.handlePendingWizardInput('research-bot');
    await service.handlePendingWizardInput('manual');
    await service.handlePendingWizardInput('research-bot');
    await service.handlePendingWizardInput('run --prompt {prompt}');
    await service.handlePendingWizardInput('research-bot --version');
    await service.handlePendingWizardInput('research,reporting');
    await service.handlePendingWizardInput('research,report_generation');
    const result = await service.handlePendingWizardInput('y');

    expect(result.handled).toBe(true);
    expect(result.lines.join('\n')).toContain('已注册 Executor：research-bot');
    expect(service.hasPendingWizard()).toBe(false);
    expect(profileService.findByName('research-bot')).toMatchObject({
      name: 'research-bot',
      runtimeCommand: 'research-bot',
      runtimeArgs: ['run', '--prompt', '{prompt}'],
      runtimeCheckCommand: 'research-bot --version',
      domains: ['research', 'reporting'],
      capabilities: ['research', 'report_generation'],
      availability: 'available',
    });
  });

  it('infers package runtime from project URL inside the admin service', async () => {
    const db = createDb();
    const service = new ExecutorAdminService({
      profileService: new ExecutorProfileService({
        db,
        defaultExecutorName: 'codex-cli',
      }),
      presentation: new SessionPresentationService(),
      fetchText: vi.fn(async url => url.endsWith('/package.json')
        ? JSON.stringify({ name: '@acme/research-bot', bin: { 'research-bot': './bin.js' } })
        : null),
    });

    service.startWizard();
    await service.handlePendingWizardInput('research-bot');
    await service.handlePendingWizardInput('url');
    const result = await service.handlePendingWizardInput('https://github.com/acme/research-bot');

    expect(result.lines.join('\n')).toContain('command=research-bot');
    expect(result.lines.join('\n')).toContain('check=research-bot --version');
  });

  it('owns executor route event persistence and display labels', () => {
    const db = createDb();
    const profileService = new ExecutorProfileService({
      db,
      defaultExecutorName: 'codex-cli',
    });
    profileService.seedDefaults();
    const { taskRuntimeService, executor } = createTaskRuntime(db);
    const task = taskRuntimeService.createTask({
      title: '写测试',
      goal: '请实现 TypeScript 单元测试',
    });
    const coordinator = new ExecutorRoutingCoordinator({
      profileService,
      taskRuntimeService,
      persistenceService: new SessionPersistenceService(db),
      defaultExecutorName: executor.name,
    });

    const routed = coordinator.resolveForTask({
      taskId: task.id,
      userInput: task.goal,
      intentDecision: {
        interactionType: 'durable_task',
        confidence: 0.8,
        reason: 'repo task',
        clarificationQuestion: null,
        risk: { level: 'low', requiresConfirmation: false, reasons: [] },
        task: { binding: 'new', taskId: null, control: 'none', scope: null },
        execution: {
          mode: 'single_executor',
          complexity: 'simple',
          selectedExecutor: 'codex-cli',
          candidateExecutors: ['codex-cli'],
          requiresVerification: true,
          canModifyFiles: true,
          requiresExternalGateway: false,
          capabilityClass: 'code_edit',
          primaryIntent: 'repo_execution',
          matchedBoundary: ['repo_execution'],
        },
        hints: [],
      },
    });

    expect(routed.eventId).toMatch(/^route_/);
    expect(coordinator.formatRoutingDecision(routed).join('\n')).toContain('route decision: codex-cli');
    expect(coordinator.formatRunLabel(routed.executionPolicy)).toBe('codex-cli');
    expect(db.prepare('SELECT selected_executor FROM executor_route_events').get()).toEqual({
      selected_executor: 'codex-cli',
    });
  });
});
