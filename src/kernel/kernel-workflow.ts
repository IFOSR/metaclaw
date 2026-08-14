import type { KernelDecision, KernelDecisionAction, KernelEvent, KernelSnapshot } from './control-kernel.js';

export interface KernelDecisionLedgerRecord {
  id: string;
  schemaVersion: 5;
  eventId: string;
  eventType: KernelEvent['type'];
  correlationId: string;
  causationId: string | null;
  sessionId: string;
  taskId: string | null;
  subtaskId: string | null;
  attemptId: string | null;
  event: KernelEvent;
  snapshot: KernelSnapshot;
  decision: KernelDecision;
  action: KernelDecision['action']['type'];
  reason: string;
  createdAt: string;
}

export interface KernelDecider {
  decide(event: KernelEvent, snapshot: KernelSnapshot): KernelDecision;
}

export interface KernelRuntime {
  apply(decision: KernelDecision): Promise<KernelEvent | null>;
}

export interface KernelWorkflowResult {
  decisions: KernelDecision[];
  quiescent: boolean;
  pendingRecovery: number;
}

export interface KernelWorkflow {
  submit(event: KernelEvent): Promise<KernelWorkflowResult>;
}

/** Audit-only persistence port. Runtime recovery is rebuilt from current domain facts. */
export interface KernelWorkflowStore {
  findDecisionByEventId(eventId: string): KernelDecisionLedgerRecord | null;
  issue(record: KernelDecisionLedgerRecord): boolean;
}

export interface KernelWorkflowClock {
  now(): string;
}

export interface KernelWorkflowRunnerDeps {
  kernel: KernelDecider;
  buildSnapshot(event: KernelEvent): KernelSnapshot;
  store: KernelWorkflowStore;
  runtime: KernelRuntime;
  clock: KernelWorkflowClock;
  acceptedEventTypes?: KernelEvent['type'][];
  acceptedActions?: KernelDecisionAction['type'][];
  taskId?: string;
}

const MAX_DECISIONS_PER_SUBMISSION = 100;

/**
 * Serial Kernel decision runner. Decisions remain durable for audit and
 * idempotent request replay; startup recovery comes from current Task,
 * attempt, session, worktree and specialized side-effect facts.
 */
export class KernelWorkflowRunner implements KernelWorkflow {
  private serial: Promise<void> = Promise.resolve();

  constructor(private readonly deps: KernelWorkflowRunnerDeps) {}

  submit(event: KernelEvent): Promise<KernelWorkflowResult> {
    const work = this.serial.then(() => this.process(event));
    this.serial = work.then(() => undefined, () => undefined);
    return work;
  }

  private async process(initialEvent: KernelEvent): Promise<KernelWorkflowResult> {
    const decisions: KernelDecision[] = [];
    let event: KernelEvent | null = initialEvent;
    while (event) {
      if (decisions.length >= MAX_DECISIONS_PER_SUBMISSION) {
        throw new Error('Kernel workflow did not reach quiescence');
      }
      if (this.deps.acceptedEventTypes && !this.deps.acceptedEventTypes.includes(event.type)) {
        throw new Error(`Kernel workflow does not accept event ${event.type}`);
      }
      if (this.deps.taskId && event.taskId && event.taskId !== this.deps.taskId) {
        throw new Error(`Kernel workflow event belongs to another Task: ${event.taskId}`);
      }

      let record = this.deps.store.findDecisionByEventId(event.id);
      if (!record) {
        const snapshot = this.deps.buildSnapshot(event);
        const decision = this.deps.kernel.decide(event, snapshot);
        const candidate = ledgerRecord(event, snapshot, decision);
        if (this.deps.store.issue(candidate)) record = candidate;
        else record = this.deps.store.findDecisionByEventId(event.id);
      }
      if (!record) throw new Error(`Kernel decision was not persisted: ${event.id}`);
      if (this.deps.acceptedActions && !this.deps.acceptedActions.includes(record.action)) {
        throw new Error(`Kernel workflow cannot apply action ${record.action}`);
      }

      decisions.push(record.decision);
      const observation = await this.deps.runtime.apply(record.decision);
      event = observation && observation.occurredAt <= this.deps.clock.now()
        ? observation
        : null;
    }
    return { decisions, quiescent: true, pendingRecovery: 0 };
  }
}

function ledgerRecord(
  event: KernelEvent,
  snapshot: KernelSnapshot,
  nextDecision: KernelDecision,
): KernelDecisionLedgerRecord {
  return {
    id: nextDecision.id,
    schemaVersion: 5,
    eventId: event.id,
    eventType: event.type,
    correlationId: event.correlationId,
    causationId: event.causationId,
    sessionId: event.sessionId,
    taskId: event.taskId ?? decisionTaskId(nextDecision),
    subtaskId: event.subtaskId ?? decisionSubtaskId(nextDecision),
    attemptId: event.attemptId ?? decisionAttemptId(nextDecision),
    event,
    snapshot,
    decision: nextDecision,
    action: nextDecision.action.type,
    reason: nextDecision.reason,
    createdAt: event.occurredAt,
  };
}

function decisionTaskId(decision: KernelDecision): string | null {
  return 'taskId' in decision.action ? decision.action.taskId : null;
}

function decisionSubtaskId(decision: KernelDecision): string | null {
  return 'subtaskId' in decision.action ? decision.action.subtaskId : null;
}

function decisionAttemptId(decision: KernelDecision): string | null {
  return decision.action.type === 'dispatch_batch' && decision.action.items.length === 1
    ? decision.action.items[0]!.attemptId
    : null;
}
