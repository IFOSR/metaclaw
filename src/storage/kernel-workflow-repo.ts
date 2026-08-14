import type Database from 'better-sqlite3';
import type { KernelDecision, KernelEvent } from '../kernel/control-kernel.js';
import type {
  KernelDecisionLedgerRecord,
  KernelWorkflowStore,
} from '../kernel/kernel-workflow.js';
import { KernelDecisionRepo } from './kernel-decision-repo.js';

/** SQLite adapter for the audit-only Kernel decision boundary. */
export class KernelWorkflowRepo implements KernelWorkflowStore {
  private readonly decisions: KernelDecisionRepo;

  constructor(db: Database.Database) {
    this.decisions = new KernelDecisionRepo(db);
  }

  findDecisionByEventId(eventId: string): KernelDecisionLedgerRecord | null {
    return this.decisions.findByEventId(eventId);
  }

  issue(record: KernelDecisionLedgerRecord): boolean {
    return this.decisions.issue(record);
  }

  findEvent(id: string): KernelEvent | null {
    return this.decisions.findByEventId(id)?.event ?? null;
  }

  listCapacitySignals(
    taskId: string,
    cycleId: string,
  ): Array<Extract<KernelEvent, { type: 'capacity_signal' }>> {
    return this.decisions.listByTask(taskId)
      .map(record => record.event)
      .filter((event): event is Extract<KernelEvent, { type: 'capacity_signal' }> => (
        event.type === 'capacity_signal' && event.cycleId === cycleId
      ));
  }

  listCurrentByAction(action: KernelDecision['action']['type']): KernelDecisionLedgerRecord[] {
    return this.decisions.listCurrentByAction(action);
  }
}
