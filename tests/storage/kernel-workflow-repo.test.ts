import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ControlKernel, type KernelEvent, type KernelSnapshot } from '../../src/kernel/control-kernel.js';
import { testPlannerExecutorCatalog } from '../support/executor-registry.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

describe('KernelWorkflowRepo', () => {
  it('stores one immutable audited decision without an event inbox or application row', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new KernelWorkflowRepo(db);
    const event = directReplyEvent();
    const snapshot = planSnapshot();
    const decision = new ControlKernel().decide(event, snapshot);
    const record = {
      id: decision.id, schemaVersion: 5 as const, eventId: event.id, eventType: event.type,
      correlationId: event.correlationId, causationId: null, sessionId: event.sessionId,
      taskId: null, subtaskId: null, attemptId: null, event, snapshot, decision,
      action: decision.action.type, reason: decision.reason, createdAt: event.occurredAt,
    };

    expect(repo.issue(record)).toBe(true);
    expect(repo.issue(record)).toBe(false);
    expect(repo.findDecisionByEventId(event.id)).toEqual(record);
    expect(repo.findEvent(event.id)).toEqual(event);
    expect(db.prepare('SELECT COUNT(*) AS count FROM kernel_decisions').get()).toEqual({ count: 1 });
  });
});

function directReplyEvent(): KernelEvent {
  return {
    schemaVersion: 5, type: 'plan_proposed', id: 'event_1', correlationId: 'correlation_1', causationId: null,
    occurredAt: '2026-07-21T00:00:00.000Z', sessionId: 'session_1',
    requestText: 'done',
    generationId: 'generation_event_1', proposalSource: 'initial', targetGraphRevision: 1,
    proposal: {
      id: 'plan_1', schemaVersion: 7, action: 'direct_reply', confidence: 1, reason: 'answer',
      clarificationQuestion: null, response: { directReply: 'done' },
      task: { binding: 'none', taskId: null, control: 'none', scope: null, title: null, goal: null, includeRecentConversationContext: false, priority: null },
      risk: { level: 'low', requiresConfirmation: false, reasons: [] }, authorizationResolution: null, workGraph: null, source: 'anyfusion-planner',
    },
  };
}

function planSnapshot(): KernelSnapshot {
  return {
    schemaVersion: 5, type: 'plan_admission', tasks: [], runningTaskId: null,
    executorCatalog: testPlannerExecutorCatalog(), executorStatuses: [], v5WorkGraphTaskIds: [], eligibleContextRefKeys: [], pendingAuthorizationRequest: null,
  };
}
