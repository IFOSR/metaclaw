import { describe, expect, it, vi } from 'vitest';
import { IntentOrchestrator } from '../../src/core/intent-orchestrator.js';
import type { IntentOrchestratorInput } from '../../src/core/intent-orchestrator.js';
import type { ExecutorProfile } from '../../src/core/executor-router.js';
import type { SemanticIntentDecision } from '../../src/core/semantic-intent-router.js';

const profiles: ExecutorProfile[] = [
  {
    name: 'codex-cli',
    domains: ['software', 'repo'],
    capabilities: ['coding', 'tests'],
    inputTypes: ['text', 'files'],
    outputTypes: ['code', 'patch'],
    strengths: [],
    weaknesses: [],
    riskLevel: 'medium',
    availability: 'available',
    historicalSuccess: 0.8,
  },
  {
    name: 'pi-agent',
    domains: ['research', 'automation'],
    capabilities: ['research', 'report_generation'],
    inputTypes: ['text'],
    outputTypes: ['markdown', 'report'],
    strengths: [],
    weaknesses: [],
    riskLevel: 'medium',
    availability: 'available',
    historicalSuccess: 0.75,
  },
];

function input(overrides: Partial<IntentOrchestratorInput> = {}): IntentOrchestratorInput {
  return {
    userInput: '请调研这个市场并输出报告',
    recentTasks: [],
    executorProfiles: profiles,
    defaultExecutorName: 'codex-cli',
    currentFocus: null,
    hints: [],
    allowDurableTask: true,
    allowFileModification: true,
    timeoutMs: 250,
    ...overrides,
  };
}

function semanticDecision(overrides: Partial<SemanticIntentDecision> = {}): SemanticIntentDecision {
  return {
    interactionType: 'executor_dispatch',
    confidence: 0.86,
    shouldAskBeforeActing: false,
    ambiguity: [],
    risk: 'medium',
    reason: '需要研究型 executor',
    clarificationQuestion: null,
    taskBinding: {
      type: 'new',
      taskId: null,
      reason: '新研究任务',
    },
    taskControl: null,
    executorDecision: {
      selectedExecutor: 'pi-agent',
      action: 'auto_dispatch',
      confidence: 0.82,
      candidates: [
        {
          executorName: 'pi-agent',
          score: 0.82,
          reason: 'research workflow',
          primaryIntent: 'research_workflow',
          matchedBoundary: ['research'],
        },
      ],
      reason: 'research workflow',
      primaryIntent: 'research_workflow',
      matchedBoundary: ['research'],
      rejected: [],
    },
    fallback: false,
    ...overrides,
  };
}

describe('IntentOrchestrator', () => {
  it('adapts semantic router output into IntentDecisionV2', async () => {
    const semanticRouter = {
      decide: vi.fn().mockResolvedValue(semanticDecision()),
    };
    const orchestrator = new IntentOrchestrator({ semanticRouter });

    const decision = await orchestrator.decide(input());

    expect(semanticRouter.decide).toHaveBeenCalledWith('请调研这个市场并输出报告', [], []);
    expect(decision).toMatchObject({
      interactionType: 'executor_dispatch',
      confidence: 0.86,
      reason: '需要研究型 executor',
      risk: {
        level: 'medium',
        requiresConfirmation: false,
      },
      task: {
        binding: 'new',
        taskId: null,
        control: 'none',
        scope: null,
      },
      execution: {
        mode: 'single_executor',
        selectedExecutor: 'pi-agent',
        candidateExecutors: ['pi-agent'],
        requiresVerification: true,
        canModifyFiles: false,
      },
    });
  });

  it('keeps rule hints as evidence but does not let them directly create tasks on semantic timeout', async () => {
    const semanticRouter = {
      decide: vi.fn().mockImplementation(() => new Promise<never>(() => {})),
    };
    const orchestrator = new IntentOrchestrator({ semanticRouter });

    const decision = await orchestrator.decide(input({
      userInput: '调研一下新能源市场',
      timeoutMs: 10,
      hints: [
        {
          source: 'heuristic',
          kind: 'durable_work',
          weight: 0.8,
          reason: 'legacy durable hint',
          evidence: '调研',
        },
      ],
    }));

    expect(decision.interactionType).toBe('clarification');
    expect(decision.task.binding).toBe('none');
    expect(decision.execution.mode).toBe('none');
    expect(decision.hints).toHaveLength(1);
    expect(decision.reason).toContain('timeout');
  });

  it('keeps task-control hints as evidence instead of overriding semantic decisions before arbitration', async () => {
    const semanticRouter = {
      decide: vi.fn().mockResolvedValue(semanticDecision({
        interactionType: 'durable_task',
        confidence: 0.8,
        reason: 'semantic model intentionally classified this as durable work',
      })),
    };
    const orchestrator = new IntentOrchestrator({
      semanticRouter,
    });

    const decision = await orchestrator.decide(input({
      userInput: '当前有没有被阻塞的任务？',
      hints: [
        {
          source: 'heuristic',
          kind: 'status_query',
          weight: 0.75,
          reason: 'task status query expression matched',
          evidence: 'blocked',
        },
      ],
    }));

    expect(semanticRouter.decide).toHaveBeenCalledTimes(1);
    expect(decision.interactionType).toBe('durable_task');
    expect(decision.task.control).toBe('none');
    expect(decision.hints).toHaveLength(1);
  });

  it('does not let focus hints bypass semantic routing', async () => {
    const semanticRouter = {
      decide: vi.fn().mockResolvedValue(semanticDecision({
        interactionType: 'direct_reply',
        confidence: 0.82,
        reason: 'semantic router accepted conversation continuation',
        taskBinding: {
          type: 'none',
          taskId: null,
          reason: 'conversation focus',
        },
        executorDecision: null,
      })),
    };
    const orchestrator = new IntentOrchestrator({ semanticRouter });

    const decision = await orchestrator.decide(input({
      userInput: '继续解释一下刚才那个点',
      currentFocus: { kind: 'conversation', taskId: null },
      hints: [
        {
          source: 'heuristic',
          kind: 'conversation_continuation',
          weight: 0.75,
          reason: 'conversation continuation expression matched',
          evidence: '继续解释',
        },
      ],
    }));

    expect(semanticRouter.decide).toHaveBeenCalledWith(
      '继续解释一下刚才那个点',
      [],
      expect.arrayContaining([expect.objectContaining({ kind: 'conversation_continuation' })]),
    );
    expect(decision.interactionType).toBe('direct_reply');
    expect(decision.reason).toBe('semantic router accepted conversation continuation');
  });

  it('normalizes semantic task-control decisions while preserving supporting hints', async () => {
    const orchestrator = new IntentOrchestrator({
      semanticRouter: {
        decide: vi.fn().mockResolvedValue(semanticDecision({
          interactionType: 'task_control',
          confidence: 0.88,
          reason: 'semantic task control decision',
          taskControl: {
            kind: 'status_query',
            scope: 'blocked',
            taskId: null,
            reason: 'semantic status query',
          },
          executorDecision: null,
        })),
      },
    });

    const decision = await orchestrator.decide(input({
      userInput: '继续刚才那个任务',
      hints: [
        {
          source: 'heuristic',
          kind: 'resume_task',
          weight: 0.7,
          reason: 'legacy resume-task expression matched',
          evidence: '继续刚才那个任务',
        },
      ],
    }));

    expect(decision.interactionType).toBe('task_control');
    expect(decision.task).toMatchObject({
      binding: 'none',
      control: 'status_query',
      scope: 'blocked',
    });
    expect(decision.execution.mode).toBe('none');
    expect(decision.hints).toHaveLength(1);
  });

  it('normalizes high-risk semantic decisions into clarification', async () => {
    const orchestrator = new IntentOrchestrator({
      semanticRouter: {
        decide: vi.fn().mockResolvedValue(semanticDecision({
          risk: 'high',
          shouldAskBeforeActing: false,
          reason: '会对外发送',
        })),
      },
    });

    const decision = await orchestrator.decide(input({ userInput: '把结果发给客户' }));

    expect(decision.interactionType).toBe('clarification');
    expect(decision.risk).toMatchObject({
      level: 'high',
      requiresConfirmation: true,
    });
    expect(decision.clarificationQuestion).toContain('确认');
  });

  it('maps race executor action to race execution mode', async () => {
    const orchestrator = new IntentOrchestrator({
      semanticRouter: {
        decide: vi.fn().mockResolvedValue(semanticDecision({
          executorDecision: {
            selectedExecutor: 'pi-agent',
            action: 'race_executors',
            confidence: 0.8,
            candidates: [
              { executorName: 'pi-agent', score: 0.8, reason: 'research', primaryIntent: 'research_workflow', matchedBoundary: ['research'] },
              { executorName: 'codex-cli', score: 0.62, reason: 'fallback', primaryIntent: 'research_workflow', matchedBoundary: ['research'] },
            ],
            reason: '需要竞速',
            primaryIntent: 'research_workflow',
            matchedBoundary: ['research'],
            rejected: [],
          },
        })),
      },
    });

    const decision = await orchestrator.decide(input());

    expect(decision.execution).toMatchObject({
      mode: 'race_executors',
      complexity: 'moderate',
      selectedExecutor: 'pi-agent',
      candidateExecutors: ['pi-agent', 'codex-cli'],
    });
  });
});
