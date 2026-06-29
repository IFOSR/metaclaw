import dayjs from 'dayjs';
import type { Task, TaskStatus } from '../core/types.js';
import type { TaskEngine } from '../task/task-engine.js';

export type TaskResumability = 'low' | 'medium' | 'high';

export interface TaskSignal {
  taskId: string;
  status: TaskStatus;
  isReady: boolean;
  progressRatio: number;
  idleHours: number;
  blocksOthers: boolean;
  hasNewMaterials: boolean;
  resumability: TaskResumability;
  lastInterruptionReason: string;
}

export class TaskSignalService {
  constructor(private taskEngine: TaskEngine) {}

  build(task: Task): TaskSignal {
    const idleHours = this.deriveIdleHours(task);
    const progressRatio = this.normalizeProgress(task.prioritySignals.progressRatio);
    const hasNewMaterials = this.deriveHasNewMaterials(task);

    return {
      taskId: task.id,
      status: task.status,
      isReady: task.prioritySignals.isReady,
      progressRatio,
      idleHours,
      blocksOthers: task.prioritySignals.blocksOthers,
      hasNewMaterials,
      resumability: this.deriveResumability(task, progressRatio, hasNewMaterials),
      lastInterruptionReason: task.lastInterruptionReason,
    };
  }

  buildAll(): TaskSignal[] {
    return this.taskEngine
      .list()
      .map(task => this.build(task));
  }

  private deriveIdleHours(task: Task): number {
    if (task.prioritySignals.idleHours > 0) {
      return task.prioritySignals.idleHours;
    }

    return Math.max(0, dayjs().diff(dayjs(task.updatedAt), 'hour'));
  }

  private deriveHasNewMaterials(task: Task): boolean {
    if (task.resources.length === 0 || task.status !== 'blocked') {
      return false;
    }

    const latestWaitingDependency = task.dependencies
      .filter(dependency => dependency.status === 'waiting')
      .sort((left, right) => dayjs(right.createdAt).valueOf() - dayjs(left.createdAt).valueOf())[0];

    if (!latestWaitingDependency) {
      return false;
    }

    return dayjs(task.updatedAt).isAfter(dayjs(latestWaitingDependency.createdAt).add(1, 'minute'));
  }

  private deriveResumability(
    task: Task,
    progressRatio: number,
    hasNewMaterials: boolean,
  ): TaskResumability {
    if (!task.prioritySignals.isReady && !hasNewMaterials) {
      return 'low';
    }

    if (
      /抢占/.test(task.lastInterruptionReason)
      || progressRatio >= 0.6
      || (task.snapshots.length > 0 && task.status === 'parked')
    ) {
      return 'high';
    }

    if (progressRatio > 0 || task.resources.length > 0 || task.snapshots.length > 0) {
      return 'medium';
    }

    return 'low';
  }

  private normalizeProgress(progressRatio: number): number {
    if (Number.isNaN(progressRatio)) {
      return 0;
    }

    return Math.min(1, Math.max(0, progressRatio));
  }
}
