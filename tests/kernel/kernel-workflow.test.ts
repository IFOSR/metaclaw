import { describe, expect, it } from 'vitest';
import { ControlKernel, type KernelDecision, type KernelEvent, type KernelSnapshot } from '../../src/kernel/control-kernel.js';
import {
  KernelWorkflowRunner,
  type KernelWorkflowStore,
} from '../../src/kernel/kernel-workflow.js';
import { testPlannerExecutorCatalog } from '../support/executor-registry.js';
import type { KernelDecisionLedgerRecord } from '../../src/kernel/kernel-workflow.js';

describe('KernelWorkflowRunner', () => {
  it('records the Kernel decision before applying it without a replay inbox', async () => {
    const store = new MemoryWorkflowStore();
    const order: string[] = [];
    const workflow = createWorkflow(store, order);

    const result = await workflow.submit(directReplyEvent());

    expect(result.decisions).toHaveLength(1);
    expect(order).toEqual(['issue:event_1', 'apply:decision_event_1']);
    expect(store.ledger?.eventId).toBe('event_1');
  });

  it('reuses and reapplies the same audited decision for an idempotent duplicate event', async () => {
    const store = new MemoryWorkflowStore();
    const order: string[] = [];
    const event = directReplyEvent();
    const snapshot = planSnapshot();
    const decision = new ControlKernel().decide(event, snapshot);
    store.issue(ledgerRecord(event, snapshot, decision));
    order.length = 0;

    const result = await createWorkflow(store, order).submit(event);

    expect(result.decisions).toEqual([decision]);
    expect(order).toEqual(['apply:decision_event_1']);
    expect(store.issueCount).toBe(1);
  });
});

function createWorkflow(store: MemoryWorkflowStore, order: string[]): KernelWorkflowRunner {
  store.onOperation = value => order.push(value);
  return new KernelWorkflowRunner({
    kernel: new ControlKernel(),
    store,
    clock: { now: () => '2026-07-21T00:00:00.000Z' },
    buildSnapshot: () => planSnapshot(),
    runtime: {
      async apply(decision) {
        order.push(`apply:${decision.id}`);
        return null;
      },
    },
  });
}

class MemoryWorkflowStore implements KernelWorkflowStore {
  ledger: KernelDecisionLedgerRecord | null = null;
  issueCount = 0;
  onOperation: (value: string) => void = () => undefined;

  findDecisionByEventId(eventId: string): KernelDecisionLedgerRecord | null {
    return this.ledger?.eventId === eventId ? this.ledger : null;
  }

  issue(record: KernelDecisionLedgerRecord): boolean {
    if (this.ledger) return false;
    this.onOperation(`issue:${record.eventId}`);
    this.issueCount += 1;
    this.ledger = record;
    return true;
  }
}

function directReplyEvent(): KernelEvent {
  return {
    schemaVersion: 5,
    type: 'plan_proposed',
    id: 'event_1',
    correlationId: 'correlation_1',
    causationId: null,
    occurredAt: '2026-07-21T00:00:00.000Z',
    sessionId: 'session_1',
    requestText: 'done',
    generationId: 'generation_event_1',
    proposalSource: 'initial',
    targetGraphRevision: 1,
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

function ledgerRecord(event: KernelEvent, snapshot: KernelSnapshot, decision: KernelDecision): KernelDecisionLedgerRecord {
  return {
    id: decision.id, schemaVersion: 5, eventId: event.id, eventType: event.type,
    correlationId: event.correlationId, causationId: event.causationId, sessionId: event.sessionId,
    taskId: null, subtaskId: null, attemptId: null, event, snapshot, decision,
    action: decision.action.type, reason: decision.reason, createdAt: event.occurredAt,
  };
}
