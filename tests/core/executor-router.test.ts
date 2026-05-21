import { describe, expect, it } from 'vitest';
import { ExecutorRouter } from '../../src/core/executor-router.js';

describe('ExecutorRouter', () => {
  it('routes high-confidence legal tasks to matching executor profiles', () => {
    const router = new ExecutorRouter([
      {
        name: 'codex-cli',
        domains: ['software'],
        capabilities: ['coding', 'tests'],
        inputTypes: ['text'],
        outputTypes: ['code'],
        strengths: ['implementation'],
        weaknesses: [],
        riskLevel: 'medium',
        availability: 'available',
        historicalSuccess: 0.8,
      },
      {
        name: 'legal-contract',
        domains: ['legal', 'contract'],
        capabilities: ['contract_review', 'risk_matrix'],
        inputTypes: ['text', 'pdf'],
        outputTypes: ['risk_matrix'],
        strengths: ['条款审查'],
        weaknesses: [],
        riskLevel: 'high',
        availability: 'available',
        historicalSuccess: 0.9,
      },
    ]);

    const decision = router.route({
      userInput: '请审查这份合同条款，输出风险矩阵',
      defaultExecutorName: 'codex-cli',
    });

    expect(decision.selectedExecutor).toBe('legal-contract');
    expect(decision.action).toBe('ask_review');
    expect(decision.reason).toContain('legal');
    expect(decision.candidates[0]).toMatchObject({
      executorName: 'legal-contract',
    });
  });

  it('falls back to default executor for low-confidence tasks', () => {
    const router = new ExecutorRouter([
      {
        name: 'codex-cli',
        domains: ['software'],
        capabilities: ['coding'],
        inputTypes: ['text'],
        outputTypes: ['code'],
        strengths: [],
        weaknesses: [],
        riskLevel: 'medium',
        availability: 'available',
        historicalSuccess: 0.7,
      },
    ]);

    const decision = router.route({
      userInput: '帮我想想这个事情',
      defaultExecutorName: 'codex-cli',
    });

    expect(decision.selectedExecutor).toBe('codex-cli');
    expect(decision.action).toBe('fallback_default');
  });

  it('routes architecture and large-context work to Claude Code profiles', () => {
    const router = new ExecutorRouter([
      {
        name: 'codex-cli',
        domains: ['software', 'repo', 'terminal'],
        capabilities: ['coding', 'tests', 'debugging'],
        inputTypes: ['text', 'files'],
        outputTypes: ['code'],
        strengths: [],
        weaknesses: [],
        riskLevel: 'medium',
        availability: 'available',
        historicalSuccess: 0.8,
      },
      {
        name: 'claude-code',
        domains: ['software', 'architecture', 'analysis', 'repo'],
        capabilities: ['architecture_review', 'long_context_analysis', 'subagents', 'mcp'],
        inputTypes: ['text', 'files'],
        outputTypes: ['code', 'plan'],
        strengths: [],
        weaknesses: [],
        riskLevel: 'medium',
        availability: 'available',
        historicalSuccess: 0.78,
      },
    ]);

    const decision = router.route({
      userInput: '请做一次大代码库长上下文架构评审，输出系统设计风险',
      defaultExecutorName: 'codex-cli',
    });

    expect(decision.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ executorName: 'claude-code' }),
      expect.objectContaining({ executorName: 'codex-cli' }),
    ]));
    expect(decision.selectedExecutor).toBe('claude-code');
    expect(decision.action).toBe('auto_dispatch');
  });

  it('routes memory and tool orchestration work to Hermes Agent profiles', () => {
    const router = new ExecutorRouter([
      {
        name: 'codex-cli',
        domains: ['software', 'repo', 'terminal'],
        capabilities: ['coding', 'tests'],
        inputTypes: ['text', 'files'],
        outputTypes: ['code'],
        strengths: [],
        weaknesses: [],
        riskLevel: 'medium',
        availability: 'available',
        historicalSuccess: 0.8,
      },
      {
        name: 'hermes-agent',
        domains: ['personal_assistant', 'research', 'automation', 'messaging', 'memory', 'agent_ops'],
        capabilities: ['persistent_memory', 'multi_tool', 'mcp', 'skill_runtime', 'messaging_gateway', 'workflow_automation'],
        inputTypes: ['text', 'image'],
        outputTypes: ['markdown', 'report'],
        strengths: [],
        weaknesses: [],
        riskLevel: 'medium',
        availability: 'available',
        historicalSuccess: 0.72,
      },
    ]);

    const decision = router.route({
      userInput: '请结合长期记忆和多工具调用做自动化调研报告',
      defaultExecutorName: 'codex-cli',
    });

    expect(decision.selectedExecutor).toBe('hermes-agent');
    expect(decision.action).toBe('auto_dispatch');
  });
});
