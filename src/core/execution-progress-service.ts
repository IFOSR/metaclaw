import type Database from 'better-sqlite3';
import type { ExecutorAdapter, ExecutorProgressEvent } from '../executor/adapter.js';
import { parseSkillUsageEventLine } from '../executor/skill-usage-event-parser.js';
import { SkillUsageEventRepo } from '../storage/skill-usage-event-repo.js';
import { generateInteractionId } from '../utils/id.js';

export interface ExecutionProgressTracker {
  readonly evidenceText: string[];
  onProgress(event: ExecutorProgressEvent, executor: ExecutorAdapter): void;
  clear(): void;
}

export interface ExecutionProgressTrackerInput {
  taskId: string;
  executionId: string;
  appendOutput: (line: string) => void;
}

export class ExecutionProgressService {
  private readonly lastProgressLineByTask = new Map<string, string>();

  constructor(private readonly db: Database.Database) {}

  createTracker(input: ExecutionProgressTrackerInput): ExecutionProgressTracker {
    const skillUsageEventRepo = new SkillUsageEventRepo(this.db);
    const evidenceText: string[] = [];
    return {
      evidenceText,
      onProgress: (event, executor) => {
        const parsedSkillEvent = event.skillEvent ?? parseSkillUsageEventLine(event.text);
        const progressText = parsedSkillEvent
          ? `Skill ${parsedSkillEvent.skillName}: ${parsedSkillEvent.message}`
          : event.text;
        const progressLine = `${parsedSkillEvent ? '🛠️' : '·'} #${input.taskId} [${executor.name}] ${progressText}`;
        if (parsedSkillEvent) {
          evidenceText.push([
            `skill_event=${parsedSkillEvent.eventType}`,
            `skill=${parsedSkillEvent.skillName}`,
            `message=${parsedSkillEvent.message}`,
            `payload=${JSON.stringify(parsedSkillEvent.payload)}`,
          ].join(' '));
          skillUsageEventRepo.insert({
            id: `sue_${generateInteractionId()}`,
            taskId: input.taskId,
            executionId: input.executionId,
            executorName: executor.name,
            skillName: parsedSkillEvent.skillName,
            skillVersion: parsedSkillEvent.skillVersion,
            eventType: parsedSkillEvent.eventType,
            message: parsedSkillEvent.message,
            payload: parsedSkillEvent.payload,
            createdAt: new Date().toISOString(),
          });
        }
        if (this.lastProgressLineByTask.get(input.taskId) === progressLine) {
          return;
        }
        this.lastProgressLineByTask.set(input.taskId, progressLine);
        input.appendOutput(progressLine);
      },
      clear: () => {
        this.lastProgressLineByTask.delete(input.taskId);
      },
    };
  }
}
