import type { AgentClassKind, Subtask, WorkUnit } from '../core/types.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
import { generateInteractionId } from '../utils/id.js';

export interface WorkUnitClaim {
  workUnit: WorkUnit;
  release(): void;
  markRunning(): void;
  heartbeat(): void;
  markWaiting(message?: string): void;
  markFailed(message?: string): void;
}

export class WorkUnitClaimService {
  constructor(
    private readonly workUnitRepo: WorkUnitRepo,
    private readonly leaseMs = 60_000,
  ) {}

  claim(input: {
    taskId: string;
    subtask: Pick<Subtask, 'id' | 'requiredAgentClassKind' | 'candidateAgentClasses'>;
  }): WorkUnitClaim | null {
    const workUnit = this.workUnitRepo.findIdleByKind(
      input.subtask.requiredAgentClassKind as AgentClassKind,
      input.subtask.candidateAgentClasses,
    );
    if (!workUnit) {
      return null;
    }

    const now = new Date();
    const heartbeatAt = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs).toISOString();
    this.workUnitRepo.updateState(workUnit.id, 'claimed', {
      claimedTaskId: input.taskId,
      claimedSubtaskId: input.subtask.id,
      heartbeatAt,
      leaseExpiresAt,
    });
    this.recordEvent(workUnit.id, input.taskId, input.subtask.id, 'claimed', 'claimed');

    return {
      workUnit: this.workUnitRepo.findById(workUnit.id)!,
      release: () => this.release(workUnit.id),
      markRunning: () => this.mark(workUnit.id, input.taskId, input.subtask.id, 'running'),
      heartbeat: () => this.mark(workUnit.id, input.taskId, input.subtask.id, 'running'),
      markWaiting: (message = 'work unit waiting') => this.mark(workUnit.id, input.taskId, input.subtask.id, 'waiting', message),
      markFailed: (message = 'work unit failed') => this.mark(workUnit.id, input.taskId, input.subtask.id, 'failed', message),
    };
  }

  sweepExpired(now = new Date()): WorkUnit[] {
    const lost = this.workUnitRepo.markHeartbeatLost(now.toISOString());
    for (const workUnit of lost) {
      this.recordEvent(
        workUnit.id,
        workUnit.claimedTaskId,
        workUnit.claimedSubtaskId,
        'heartbeat_lost',
        'heartbeat_lost',
      );
    }
    return lost;
  }

  private mark(
    workUnitId: string,
    taskId: string,
    subtaskId: string,
    state: 'running' | 'waiting' | 'failed',
    message: string = state,
  ): void {
    const now = new Date();
    this.workUnitRepo.updateState(workUnitId, state, {
      claimedTaskId: taskId,
      claimedSubtaskId: subtaskId,
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
    });
    this.recordEvent(workUnitId, taskId, subtaskId, state, state, message);
  }

  private release(workUnitId: string): void {
    this.workUnitRepo.updateState(workUnitId, 'idle', {
      claimedTaskId: null,
      claimedSubtaskId: null,
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: null,
    });
    this.recordEvent(workUnitId, null, null, 'released', 'idle');
  }

  private recordEvent(
    workUnitId: string,
    taskId: string | null,
    subtaskId: string | null,
    eventType: string,
    state: 'claimed' | 'running' | 'waiting' | 'failed' | 'heartbeat_lost' | 'idle',
    message = eventType,
  ): void {
    this.workUnitRepo.insertEvent({
      id: `wue_${generateInteractionId()}`,
      workUnitId,
      taskId,
      subtaskId,
      eventType,
      state,
      message,
      payload: {},
      createdAt: new Date().toISOString(),
    });
  }
}
