import type { Task, Dashboard, Suggestion, PriorityScore } from './types.js';
import type { TaskEngine } from './task-engine.js';
import dayjs from 'dayjs';

const WEIGHTS = {
  urgency: 3,
  readiness: 2,
  continuityBenefit: 2,
  downstreamImpact: 2,
  staleness: 1,
};

export class OrchestrationEngine {
  constructor(private taskEngine: TaskEngine) {}

  /**
   * 生成任务盘面
   */
  getDashboard(): Dashboard {
    const tasks = this.taskEngine['taskRepo'].findActive();

    const summary = {
      active: tasks.filter(t => ['created', 'ready', 'running', 'parked'].includes(t.status)).length,
      blocked: tasks.filter(t => t.status === 'blocked').length,
      parked: tasks.filter(t => t.status === 'parked').length,
      done: this.taskEngine['taskRepo'].findByStatus('done').length,
    };

    const readyTasks = tasks.filter(t => t.status === 'ready');
    const blockedTasks = tasks.filter(t => t.status === 'blocked');

    const prioritized = this.getPrioritizedTasks();
    const priorityTask = prioritized.length > 0 ? prioritized[0] : null;

    const blockedWithReasons = blockedTasks.map(t => ({
      ...t,
      blockReason: t.dependencies.find(d => d.status === 'waiting')?.description || '未知原因',
    }));

    return {
      summary,
      priorityTask: priorityTask ? {
        ...priorityTask.task,
        reasons: priorityTask.reasons,
      } : null,
      blockedTasks: blockedWithReasons,
      readyTasks,
    };
  }

  /**
   * 获取优先级排序后的 READY 任务
   */
  getPrioritizedTasks(): Array<{ task: Task; score: PriorityScore; reasons: string[] }> {
    const tasks = this.taskEngine['taskRepo'].findByStatus('ready');

    const scored = tasks.map(task => {
      const { score, reasons } = this.evaluateTask(task);
      return { task, score, reasons };
    });

    scored.sort((a, b) => b.score.total - a.score.total);
    return scored;
  }

  evaluateTask(task: Task): { score: PriorityScore; reasons: string[] } {
    const score = this.calculatePriorityScore(task);
    const reasons = this.generateReasons(task, score);
    return { score, reasons };
  }

  /**
   * 获取所有 BLOCKED 任务及卡点原因
   */
  getBlockedTasks(): Array<Task & { blockReason: string }> {
    const tasks = this.taskEngine['taskRepo'].findByStatus('blocked');
    return tasks.map(t => ({
      ...t,
      blockReason: t.dependencies.find(d => d.status === 'waiting')?.description || '未知原因',
    }));
  }

  /**
   * 任务完成后推荐下一个
   */
  suggestNext(completedTaskId: string): Suggestion | null {
    const prioritized = this.getPrioritizedTasks();
    if (prioritized.length === 0) return null;

    const next = prioritized[0];
    return {
      taskId: next.task.id,
      type: 'priority_suggestion',
      reasons: next.reasons,
      recommendedAction: `继续处理任务 #${next.task.id}: ${next.task.title}`,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 生成主动建议
   */
  generateSuggestions(): Suggestion[] {
    const suggestions: Suggestion[] = [];

    // 高优先级任务建议
    const prioritized = this.getPrioritizedTasks();
    if (prioritized.length > 0 && prioritized[0].score.total >= 20) {
      suggestions.push({
        taskId: prioritized[0].task.id,
        type: 'priority_suggestion',
        reasons: prioritized[0].reasons,
        recommendedAction: `建议优先处理: ${prioritized[0].task.title}`,
        generatedAt: new Date().toISOString(),
      });
    }

    // Blocked 任务提醒
    const blocked = this.getBlockedTasks();
    for (const task of blocked) {
      suggestions.push({
        taskId: task.id,
        type: 'unblock_reminder',
        reasons: [`任务被阻塞: ${task.blockReason}`],
        recommendedAction: `检查并解除阻塞`,
        generatedAt: new Date().toISOString(),
      });
    }

    return suggestions;
  }

  /**
   * 计算优先级评分
   */
  private calculatePriorityScore(task: Task): PriorityScore {
    const urgency = this.scoreUrgency(task);
    const readiness = this.scoreReadiness(task);
    const continuityBenefit = this.scoreContinuityBenefit(task);
    const downstreamImpact = this.scoreDownstreamImpact(task);
    const staleness = this.scoreStaleness(task);

    const total =
      urgency * WEIGHTS.urgency +
      readiness * WEIGHTS.readiness +
      continuityBenefit * WEIGHTS.continuityBenefit +
      downstreamImpact * WEIGHTS.downstreamImpact +
      staleness * WEIGHTS.staleness;

    return { urgency, readiness, continuityBenefit, downstreamImpact, staleness, total };
  }

  private scoreUrgency(task: Task): number {
    if (!task.prioritySignals.dueAt) return 0;
    const hoursLeft = dayjs(task.prioritySignals.dueAt).diff(dayjs(), 'hour');
    if (hoursLeft < 0) return 10;
    if (hoursLeft < 4) return 9;
    if (hoursLeft < 24) return 7;
    if (hoursLeft < 72) return 4;
    return 1;
  }

  private scoreReadiness(task: Task): number {
    return task.prioritySignals.isReady ? 8 : 2;
  }

  private scoreContinuityBenefit(task: Task): number {
    return Math.round(task.prioritySignals.progressRatio * 10);
  }

  private scoreDownstreamImpact(task: Task): number {
    return task.prioritySignals.blocksOthers ? 8 : 0;
  }

  private scoreStaleness(task: Task): number {
    const hours = dayjs().diff(dayjs(task.updatedAt), 'hour');
    if (hours > 168) return 8;
    if (hours > 72) return 5;
    if (hours > 24) return 3;
    return 0;
  }

  /**
   * 生成建议原因
   */
  private generateReasons(task: Task, score: PriorityScore): string[] {
    const reasons: string[] = [];
    if (score.continuityBenefit >= 7)
      reasons.push(`已完成 ${Math.round(task.prioritySignals.progressRatio * 100)}%，继续成本最低`);
    if (score.readiness >= 8)
      reasons.push('所有输入材料已齐全');
    if (score.urgency >= 7)
      reasons.push('截止时间临近');
    if (score.downstreamImpact >= 8)
      reasons.push('阻塞了其他任务');
    if (score.staleness >= 5) {
      const hours = dayjs().diff(dayjs(task.updatedAt), 'hour');
      reasons.push(`已搁置 ${hours} 小时`);
    }
    return reasons;
  }
}
