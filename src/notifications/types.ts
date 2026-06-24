import type { TaskRecoveryTrigger } from '../core/types.js';

export interface MemoryCandidateNotification {
  observationId: string;
  pattern: string;
  source: 'high-confidence' | 'repeated-pattern';
}

export interface TaskCompletedNotification {
  taskId: string;
  title: string;
  summary: string;
  output: string;
  artifactPaths: string[];
  durationMs: number;
  executionMode: 'fresh' | 'resume-parked' | 'resume-blocked' | 'follow-up';
  origin: 'user' | 'system';
  recoveryTrigger?: TaskRecoveryTrigger;
}

export interface NotificationService {
  notifyMemoryCandidate(input: MemoryCandidateNotification): Promise<void>;
  notifyTaskCompleted(input: TaskCompletedNotification): Promise<void>;
}

export class NoopNotificationService implements NotificationService {
  async notifyMemoryCandidate(): Promise<void> {
    // Notifications are optional integrations; disabled config should be silent.
  }

  async notifyTaskCompleted(): Promise<void> {
    // Notifications are optional integrations; disabled config should be silent.
  }
}
