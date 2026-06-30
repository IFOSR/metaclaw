import { describe, expect, it, vi } from 'vitest';
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

function queryRouter(output: unknown): { router: SemanticIntentRouter; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue(JSON.stringify(output));
  return {
    router: new SemanticIntentRouter({ query }, profiles, {
      defaultExecutorName: 'codex-cli',
      llmTimeoutMs: 50,
    }),
    query,
  };
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
  it('does not let parser clear hints bypass semantic query arbitration', async () => {
    const { router, query } = queryRouter({
      interactionType: 'direct_reply',
      confidence: 0.9,
      shouldAskBeforeActing: false,
      ambiguity: [],
      risk: 'low',
      capabilityClass: 'conversation',
      reason: 'semantic model decided this is conversational',
      clarificationQuestion: null,
      taskBinding: { type: 'none', taskId: null, reason: 'conversation' },
      taskControl: null,
      executorDecision: null,
    });

    const decision = await router.decide('清空阻塞任务是什么意思？', [], [hint('clear_tasks', 'blocked')]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('Rule hints');
    expect(decision.interactionType).toBe('direct_reply');
    expect(decision.taskControl).toBeNull();
  });

  it('does not let resume hints override a semantic durable-task decision', async () => {
    const { router } = queryRouter({
      interactionType: 'durable_task',
      confidence: 0.9,
      shouldAskBeforeActing: false,
      ambiguity: [],
      risk: 'low',
      capabilityClass: 'code_edit',
      reason: 'semantic model decided this creates new work',
      clarificationQuestion: null,
      taskBinding: { type: 'new', taskId: null, reason: 'new work' },
      taskControl: null,
      executorDecision: {
        selectedExecutor: 'codex-cli',
        action: 'auto_dispatch',
        confidence: 0.9,
        primaryIntent: 'repo_execution',
        matchedBoundary: ['repo_execution'],
        reason: 'repo work',
        candidates: [{ executorName: 'codex-cli', score: 0.9, reason: 'repo work', matchedBoundary: ['repo_execution'] }],
        rejected: [],
      },
    });

    const decision = await router.decide('继续把文档整理成任务', [], [hint('resume_task', '继续把文档整理成任务')]);

    expect(decision.interactionType).toBe('durable_task');
    expect(decision.taskControl).toBeNull();
    expect(decision.taskBinding.type).toBe('new');
  });

  it('derives primary intent from capability class when the model emits a CapabilityClass in primaryIntent', async () => {
    const { router } = queryRouter({
      interactionType: 'executor_dispatch',
      confidence: 0.9,
      shouldAskBeforeActing: false,
      ambiguity: [],
      risk: 'low',
      capabilityClass: 'research',
      reason: 'semantic model chose research work',
      clarificationQuestion: null,
      taskBinding: { type: 'new', taskId: null, reason: 'new research work' },
      taskControl: null,
      executorDecision: {
        selectedExecutor: 'codex-cli',
        action: 'auto_dispatch',
        confidence: 0.9,
        primaryIntent: 'code_edit',
        matchedBoundary: ['research'],
        reason: 'model used CapabilityClass vocabulary in primaryIntent',
        candidates: [],
        rejected: [],
      },
    });

    const decision = await router.decide('research this topic', [], []);

    expect(decision.capabilityClass).toBe('research');
    expect(decision.executorDecision?.primaryIntent).toBe('research_workflow');
  });

  it('does not map legacy technical_reasoning to code_edit capability', async () => {
    const { router } = queryRouter({
      interactionType: 'executor_dispatch',
      confidence: 0.9,
      shouldAskBeforeActing: false,
      ambiguity: [],
      risk: 'low',
      reason: 'read-only code reasoning',
      clarificationQuestion: null,
      taskBinding: { type: 'new', taskId: null, reason: 'analysis work' },
      taskControl: null,
      executorDecision: {
        selectedExecutor: 'codex-cli',
        action: 'auto_dispatch',
        confidence: 0.9,
        primaryIntent: 'technical_reasoning',
        matchedBoundary: ['reasoning'],
        reason: 'read-only analysis',
        candidates: [],
        rejected: [],
      },
    });

    const decision = await router.decide('analyze this code without editing files', [], []);

    expect(decision.capabilityClass).toBe('general');
    expect(decision.executorDecision?.primaryIntent).toBe('technical_reasoning');
  });

  it('preserves explicit parser hints as evidence when the semantic model chooses task control', async () => {
    const { router } = queryRouter({
      interactionType: 'task_control',
      confidence: 0.9,
      shouldAskBeforeActing: false,
      ambiguity: [],
      risk: 'low',
      capabilityClass: 'conversation',
      reason: 'semantic model chose explicit task clear',
      clarificationQuestion: null,
      taskBinding: { type: 'none', taskId: null, reason: 'task control' },
      taskControl: { kind: 'clear_tasks', taskId: null, scope: 'blocked', reason: 'clear blocked tasks' },
      executorDecision: null,
    });

    const decision = await router.decide('清空阻塞任务', [], [hint('clear_tasks', 'blocked')]);

    expect(decision.interactionType).toBe('task_control');
    expect(decision.taskControl).toMatchObject({
      kind: 'clear_tasks',
      scope: 'blocked',
    });
    expect(decision.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('does not directly convert status hints when no semantic bridge is available', async () => {
    const decision = await router().decide('当前有没有被阻塞的任务？', [], [hint('status_query', 'blocked')]);

    expect(decision.interactionType).toBe('direct_reply');
    expect(decision.fallback).toBe(true);
    expect(decision.taskControl).toBeNull();
  });

  it('does not directly convert explicit task id resume hints when no semantic bridge is available', async () => {
    const decision = await router().decide('恢复 task_abc123', [], [hint('resume_task', 'task_abc123')]);

    expect(decision.interactionType).toBe('direct_reply');
    expect(decision.fallback).toBe(true);
    expect(decision.taskBinding.taskId).toBeNull();
  });

  it('does not directly convert conversation continuation hints when no semantic bridge is available', async () => {
    const decision = await router().decide('继续解释一下刚才那个点', [], [{
      source: 'heuristic',
      kind: 'conversation_continuation',
      weight: 0.75,
      reason: 'conversation continuation expression matched',
      evidence: '继续解释',
    }]);

    expect(decision.interactionType).toBe('direct_reply');
    expect(decision.fallback).toBe(true);
    expect(decision.taskBinding.type).toBe('none');
    expect(decision.executorDecision).toBeNull();
  });

  it('does not directly convert conversation-derived work hints when no semantic bridge is available', async () => {
    const decision = await router().decide('把刚才讨论的方案整理成任务', [], [{
      source: 'heuristic',
      kind: 'durable_work',
      weight: 0.72,
      reason: 'conversation follow-up durable work expression matched',
      evidence: '整理成任务',
    }]);

    expect(decision.interactionType).toBe('direct_reply');
    expect(decision.fallback).toBe(true);
    expect(decision.taskBinding.type).toBe('none');
    expect(decision.executorDecision).toBeNull();
  });
});
