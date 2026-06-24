import { describe, expect, it } from 'vitest';
import { SemanticIntentRouter } from '../../src/core/semantic-intent-router.js';
import type { ExecutorProfile } from '../../src/core/executor-router.js';
import type { RuleHint } from '../../src/core/rule-hints-provider.js';

const profiles: ExecutorProfile[] = [{
  name: 'codex-cli',
  domains: ['general'],
  capabilities: ['general'],
  inputTypes: ['text'],
  outputTypes: ['markdown'],
  strengths: [],
  weaknesses: [],
  riskLevel: 'medium',
  availability: 'available',
  historicalSuccess: 0.8,
}];

function router(): SemanticIntentRouter {
  return new SemanticIntentRouter({}, profiles, {
    defaultExecutorName: 'codex-cli',
    llmTimeoutMs: 50,
  });
}

function hint(kind: RuleHint['kind'], evidence: string): RuleHint {
  return {
    source: kind === 'clear_tasks' ? 'parser' : 'heuristic',
    kind,
    weight: kind === 'clear_tasks' ? 0.95 : 0.8,
    reason: `${kind} matched`,
    evidence,
  };
}

describe('SemanticIntentRouter rule hint arbitration', () => {
  it('converts explicit parser hints into semantic task-control decisions', async () => {
    const decision = await router().decide('清空阻塞任务', [], [hint('clear_tasks', 'blocked')]);

    expect(decision.interactionType).toBe('task_control');
    expect(decision.taskControl).toMatchObject({
      kind: 'clear_tasks',
      scope: 'blocked',
    });
    expect(decision.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('converts status hints into semantic task-control decisions', async () => {
    const decision = await router().decide('当前有没有被阻塞的任务？', [], [hint('status_query', 'blocked')]);

    expect(decision.interactionType).toBe('task_control');
    expect(decision.taskControl).toMatchObject({
      kind: 'status_query',
      scope: 'blocked',
    });
  });

  it('converts explicit task id resume hints into referenced task-control decisions', async () => {
    const decision = await router().decide('恢复 task_abc123', [], [hint('resume_task', 'task_abc123')]);

    expect(decision.interactionType).toBe('task_control');
    expect(decision.taskBinding).toMatchObject({
      type: 'reference',
      taskId: 'task_abc123',
    });
    expect(decision.taskControl).toMatchObject({
      kind: 'resume_task',
      taskId: 'task_abc123',
    });
  });

  it('converts conversation continuation hints into semantic direct replies', async () => {
    const decision = await router().decide('继续解释一下刚才那个点', [], [{
      source: 'heuristic',
      kind: 'conversation_continuation',
      weight: 0.75,
      reason: 'conversation continuation expression matched',
      evidence: '继续解释',
    }]);

    expect(decision.interactionType).toBe('direct_reply');
    expect(decision.taskBinding.type).toBe('none');
    expect(decision.executorDecision).toBeNull();
    expect(decision.reason).toContain('延续当前对话');
  });

  it('converts conversation-derived work hints into semantic durable tasks', async () => {
    const decision = await router().decide('把刚才讨论的方案整理成任务', [], [{
      source: 'heuristic',
      kind: 'durable_work',
      weight: 0.72,
      reason: 'conversation follow-up durable work expression matched',
      evidence: '整理成任务',
    }]);

    expect(decision.interactionType).toBe('durable_task');
    expect(decision.taskBinding.type).toBe('new');
    expect(decision.executorDecision).toMatchObject({
      selectedExecutor: 'codex-cli',
      action: 'auto_dispatch',
      primaryIntent: 'repo_execution',
      matchedBoundary: ['conversation_follow_up'],
    });
  });
});
