import type Database from 'better-sqlite3';
import type { ExecutorRouteDecision } from '../core/executor-router.js';
import { ExecutorRouteEventRepo } from '../storage/executor-route-event-repo.js';
import { generateInteractionId } from '../utils/id.js';

export interface InteractionRecordInput {
  taskId: string | null;
  sessionId: string;
  userInput: string;
  systemOutput: string;
  executorUsed: string;
}

export interface RouteEventRecordInput {
  taskId: string | null;
  userInput: string;
  decision: ExecutorRouteDecision;
}

export class SessionPersistenceService {
  private readonly routeEventRepo: ExecutorRouteEventRepo;

  constructor(private readonly db: Database.Database) {
    this.routeEventRepo = new ExecutorRouteEventRepo(db);
  }

  recordInteraction(input: InteractionRecordInput): void {
    this.db.prepare(
      'INSERT INTO interactions (id, task_id, session_id, user_input, system_output, executor_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      generateInteractionId(),
      input.taskId,
      input.sessionId,
      input.userInput,
      input.systemOutput,
      input.executorUsed,
      new Date().toISOString(),
    );
  }

  recordRouteEvent(input: RouteEventRecordInput): string {
    const eventId = `route_${generateInteractionId()}`;
    const decision = input.decision;
    this.routeEventRepo.insert({
      id: eventId,
      taskId: input.taskId,
      userInput: input.userInput,
      selectedExecutor: decision.selectedExecutor,
      action: decision.action,
      candidates: decision.candidates,
      primaryIntent: decision.primaryIntent,
      matchedBoundary: decision.matchedBoundary,
      rejected: decision.rejected,
      reason: decision.reason,
      confirmedByUser: false,
      result: null,
      createdAt: new Date().toISOString(),
    });
    return eventId;
  }

  markRouteEventResult(eventId: string, result: string): void {
    this.routeEventRepo.updateResult(eventId, result);
  }
}
