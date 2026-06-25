import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

function readSource(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf-8');
}

describe('Task runtime architecture boundaries', () => {
  it('keeps SchedulerEngine behind TaskRuntimeService instead of direct task repo access', () => {
    const source = readSource('src/core/scheduler.ts');

    expect(source).not.toContain("taskEngine['taskRepo']");
    expect(source).not.toContain('.findByStatus(');
    expect(source).not.toContain('.findById(');
    expect(source).not.toContain('.update(');
    expect(source).toContain('TaskRuntimeService');
  });

  it('keeps active dispatch lifecycle inside SchedulerEngine instead of MetaclawSession', () => {
    const schedulerSource = readSource('src/core/scheduler.ts');
    const sessionSource = readSource('src/session/metaclaw-session.ts');

    expect(schedulerSource).toContain('activeDispatches');
    expect(schedulerSource).toContain('waitForIdle');
    expect(sessionSource).not.toContain('activeDispatches');
    expect(sessionSource).toContain('scheduler.waitForIdle');
  });

  it('keeps queued execution requests inside SchedulerEngine instead of MetaclawSession', () => {
    const schedulerSource = readSource('src/core/scheduler.ts');
    const sessionSource = readSource('src/session/metaclaw-session.ts');
    const executionApplicationSource = readSource('src/session/session-task-execution-application-service.ts');

    expect(schedulerSource).toContain('queuedExecution');
    expect(schedulerSource).toContain('executionRequest');
    expect(sessionSource).not.toContain('queuedExecution');
    expect(sessionSource).not.toContain('executionRequest: request');
    expect(executionApplicationSource).toContain('executionRequest: request');
  });

  it('implements the SchedulerBridge dispatch lifecycle on SchedulerEngine', () => {
    const schedulerSource = readSource('src/core/scheduler.ts');

    expect(schedulerSource).toContain('markDispatchStarted');
    expect(schedulerSource).toContain('markDispatchFinished');
    expect(schedulerSource).toContain('markDispatchBlocked');
    expect(schedulerSource).toContain('activeDispatchIds');
  });

  it('keeps MetaclawSession task lifecycle mutations behind TaskRuntimeService', () => {
    const source = readSource('src/session/metaclaw-session.ts');

    expect(source).not.toContain('private currentTaskId');
    expect(source).not.toContain('private focusContext');
    expect(source).not.toContain('this.currentTaskId');
    expect(source).not.toContain('this.focusContext');
    expect(source).not.toContain("deps.taskEngine['taskRepo']");
    expect(source).not.toContain('deps.taskEngine.create(');
    expect(source).not.toContain('deps.taskEngine.unblock(');
    expect(source).not.toContain('deps.taskEngine.block(');
    expect(source).not.toContain('deps.taskEngine.park(');
    expect(source).not.toContain('deps.taskEngine.transition(');
    expect(source).not.toContain("deps.taskEngine['taskRepo']");
    expect(source).toContain('taskRuntimeService');
  });

  it('keeps TaskRuntimeService out of LLM and executor routing decisions', () => {
    const source = readSource('src/core/task-runtime-service.ts');
    const semanticSource = readSource('src/core/task-semantic-service.ts');

    expect(source).not.toContain("from './llm-bridge.js'");
    expect(source).not.toContain('llmBridge');
    expect(source).not.toContain('resolveTaskPriority');
    expect(source).not.toContain('resolveTaskResumeIntent');
    expect(source).not.toContain('IntentOrchestrator');
    expect(source).not.toContain('ExecutorRouter');
    expect(source).not.toContain('createExecutor');
    expect(semanticSource).toContain("from './llm-bridge.js'");
    expect(semanticSource).toContain('resolveTaskPriority');
    expect(semanticSource).toContain('resolveTaskResumeIntent');
  });

  it('keeps clear-task presentation labels outside TaskRuntimeService', () => {
    const runtimeSource = readSource('src/core/task-runtime-service.ts');
    const presentationSource = readSource('src/session/session-presentation-service.ts');

    expect(runtimeSource).not.toContain('CLEAR_SCOPE_LABELS');
    expect(runtimeSource).not.toContain("all: '所有未完成任务'");
    expect(runtimeSource).not.toContain("parked: '挂起任务'");
    expect(runtimeSource).not.toContain("blocked: '阻塞任务'");
    expect(presentationSource).toContain('CLEAR_SCOPE_LABELS');
    expect(presentationSource).toContain('所有未完成任务');
    expect(presentationSource).toContain('挂起任务');
    expect(presentationSource).toContain('阻塞任务');
  });
});
