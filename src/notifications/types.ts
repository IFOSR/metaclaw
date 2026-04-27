export interface MemoryCandidateNotification {
  observationId: string;
  pattern: string;
  source: 'high-confidence' | 'repeated-pattern';
}

export interface NotificationService {
  notifyMemoryCandidate(input: MemoryCandidateNotification): Promise<void>;
}

export class NoopNotificationService implements NotificationService {
  async notifyMemoryCandidate(): Promise<void> {
    // Notifications are optional integrations; disabled config should be silent.
  }
}
