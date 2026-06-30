import { describe, expect, it } from 'vitest';
import { ExecutorRouter } from '../../src/core/executor-router.js';
import type { ExecutorProfile } from '../../src/core/executor-router.js';

function boundaryProfiles(): ExecutorProfile[] {
  return [
    {
      name: 'codex-cli',
      domains: ['software', 'repo', 'terminal', 'code_review'],
      capabilities: ['coding', 'tests', 'debugging', 'refactor', 'code_review', 'sandboxed_execution', 'noninteractive_execution'],
      inputTypes: ['text', 'files'],
      outputTypes: ['code', 'patch', 'markdown', 'review'],
      strengths: ['local repository editing'],
      weaknesses: [],
      primaryUseCases: ['实现这个功能', '修这个 bug', '跑测试并修复失败', '重构这个模块', 'PR review 并给 patch'],
      avoidUseCases: ['市场调研', '消息网关', '长期记忆'],
      intentAffinity: { repo_execution: 1, technical_reasoning: 0.45, research_workflow: 0.15, memory_agent_ops: 0.1 },
      riskLevel: 'medium',
      availability: 'available',
      historicalSuccess: 0.85,
    },
    {
      name: 'deepseek-tui',
      domains: ['software', 'repo', 'terminal', 'code_review', 'reasoning', 'algorithm', 'math', 'chinese_analysis'],
      capabilities: ['coding', 'tests', 'debugging', 'refactor', 'code_review', 'code_execution', 'deepseek_reasoning', 'agentic_tui'],
      inputTypes: ['text', 'files'],
      outputTypes: ['code', 'patch', 'markdown', 'review', 'analysis'],
      strengths: ['DeepSeek model reasoning'],
      weaknesses: [],
      primaryUseCases: ['用 DeepSeek 分析', '复杂算法推理', '数学推导', '中文技术分析', '分析这段代码的边界条件'],
      avoidUseCases: ['多来源商业调研', '消息网关'],
      intentAffinity: { repo_execution: 0.55, technical_reasoning: 1, research_workflow: 0.25, memory_agent_ops: 0.15 },
      riskLevel: 'medium',
      availability: 'available',
      historicalSuccess: 0.76,
    },
    {
      name: 'hermes-agent',
      domains: ['personal_assistant', 'research', 'automation', 'messaging', 'memory', 'agent_ops'],
      capabilities: ['persistent_memory', 'research', 'multi_tool', 'mcp', 'skill_runtime', 'messaging_gateway', 'workflow_automation'],
      inputTypes: ['text', 'image'],
      outputTypes: ['markdown', 'report'],
      strengths: ['research workflows', 'toolset orchestration'],
      weaknesses: [],
      primaryUseCases: ['调研并输出报告', '整理多份资料', '多工具调用', '自动化工作流'],
      avoidUseCases: ['纯本地代码实现', '数学推导', '算法推理'],
      intentAffinity: { repo_execution: 0.15, technical_reasoning: 0.25, research_workflow: 1, memory_agent_ops: 1 },
      riskLevel: 'medium',
      availability: 'available',
      historicalSuccess: 0.72,
    },
    {
      name: 'pi-agent',
      domains: ['research', 'automation', 'agent_ops', 'reporting', 'analysis'],
      capabilities: ['research', 'multi_tool', 'workflow_automation', 'agentic_cli', 'report_generation', 'code_execution'],
      inputTypes: ['text', 'files'],
      outputTypes: ['markdown', 'report'],
      strengths: ['research workflows'],
      weaknesses: [],
      primaryUseCases: ['调研并输出报告', '整理多份资料', '自动化工作流', '市场调研'],
      avoidUseCases: ['纯本地代码实现', '数学推导', '算法推理', '消息网关发送'],
      intentAffinity: { repo_execution: 0.2, technical_reasoning: 0.45, research_workflow: 1, memory_agent_ops: 0.65 },
      riskLevel: 'medium',
      availability: 'available',
      historicalSuccess: 0.78,
    },
  ];
}

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
    expect(decision.action).toBe('ask_clarification');
    expect(decision.reason).toContain('contract_review');
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

  it('routes memory and tool orchestration work to a Pi/Hermes research agent candidate', () => {
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
        capabilities: ['persistent_memory', 'research', 'multi_tool', 'mcp', 'skill_runtime', 'messaging_gateway', 'workflow_automation'],
        inputTypes: ['text', 'image'],
        outputTypes: ['markdown', 'report'],
        strengths: [],
        weaknesses: [],
        riskLevel: 'medium',
        availability: 'available',
        historicalSuccess: 0.72,
      },
      {
        name: 'pi-agent',
        domains: ['research', 'automation', 'agent_ops', 'reporting'],
        capabilities: ['research', 'multi_tool', 'workflow_automation', 'report_generation'],
        inputTypes: ['text', 'files'],
        outputTypes: ['markdown', 'report'],
        strengths: [],
        weaknesses: [],
        riskLevel: 'medium',
        availability: 'available',
        historicalSuccess: 0.78,
      },
    ]);

    const decision = router.route({
      userInput: '请结合长期记忆和多工具调用做自动化调研报告',
      defaultExecutorName: 'codex-cli',
    });

    expect(['pi-agent', 'hermes-agent']).toContain(decision.selectedExecutor);
    expect(decision.action).toBe('auto_dispatch');
    expect(decision.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ executorName: 'pi-agent' }),
      expect.objectContaining({ executorName: 'hermes-agent' }),
    ]));
  });

  it('routes plain research tasks to a Pi/Hermes research agent instead of falling back to Codex', () => {
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
        historicalSuccess: 0.85,
      },
      {
        name: 'hermes-agent',
        domains: ['personal_assistant', 'research', 'automation', 'messaging', 'memory', 'agent_ops'],
        capabilities: ['persistent_memory', 'research', 'multi_tool', 'mcp', 'skill_runtime', 'messaging_gateway', 'workflow_automation'],
        inputTypes: ['text', 'image'],
        outputTypes: ['markdown', 'report'],
        strengths: [],
        weaknesses: [],
        riskLevel: 'medium',
        availability: 'available',
        historicalSuccess: 0.72,
      },
      {
        name: 'pi-agent',
        domains: ['research', 'automation', 'agent_ops', 'reporting'],
        capabilities: ['research', 'multi_tool', 'workflow_automation', 'report_generation'],
        inputTypes: ['text', 'files'],
        outputTypes: ['markdown', 'report'],
        strengths: [],
        weaknesses: [],
        riskLevel: 'medium',
        availability: 'available',
        historicalSuccess: 0.78,
      },
    ]);

    const decision = router.route({
      userInput: '帮我调研一下 AI agent 未来发展趋势，输出报告',
      defaultExecutorName: 'codex-cli',
    });

    expect(['pi-agent', 'hermes-agent']).toContain(decision.selectedExecutor);
    expect(decision.action).toBe('auto_dispatch');
    expect(decision.confidence).toBeGreaterThanOrEqual(0.45);
    expect(decision.reason).toContain('research');
    expect(decision.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ executorName: 'hermes-agent' }),
    ]));
  });

  it('routes DeepSeek reasoning and algorithm work to DeepSeek TUI', () => {
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
        historicalSuccess: 0.85,
      },
      {
        name: 'deepseek-tui',
        domains: ['software', 'repo', 'terminal', 'code_review', 'reasoning', 'algorithm', 'math', 'chinese_analysis'],
        capabilities: ['coding', 'tests', 'debugging', 'refactor', 'code_review', 'code_execution', 'deepseek_reasoning', 'agentic_tui'],
        inputTypes: ['text', 'files'],
        outputTypes: ['code', 'patch', 'markdown', 'review', 'analysis'],
        strengths: [],
        weaknesses: [],
        riskLevel: 'medium',
        availability: 'available',
        historicalSuccess: 0.76,
      },
    ]);

    const decision = router.route({
      userInput: '用 DeepSeek 做一次复杂算法推理，分析这段代码的边界条件并给中文技术结论',
      defaultExecutorName: 'codex-cli',
    });

    expect(decision.selectedExecutor).toBe('deepseek-tui');
    expect(decision.action).toBe('auto_dispatch');
    expect(decision.reason).toContain('reasoning');
  });

  it.each([
    ['修复这个 TypeScript bug 并跑测试', 'codex-cli', 'repo_execution'],
    ['用 DeepSeek 做复杂算法推理，输出中文技术分析', 'deepseek-tui', 'technical_reasoning'],
    ['调研 AI Agent 市场并输出报告', 'research-agent', 'research_workflow'],
    ['结合长期记忆和多工具调用做自动化调研报告', 'research-agent', 'memory_agent_ops'],
    ['分析这段代码边界条件，不改文件', 'deepseek-tui', 'technical_reasoning'],
    ['分析这段代码并直接修复测试', 'codex-cli', 'repo_execution'],
    ['代码 review，重点看算法正确性，用中文解释', 'deepseek-tui', 'technical_reasoning'],
    ['PR review 并给 patch', 'codex-cli', 'repo_execution'],
    ['消息网关自动通知客户', 'codex-cli', 'memory_agent_ops'],
  ] as const)('routes boundary matrix case %#', (userInput, selectedExecutor, primaryIntent) => {
    const decision = new ExecutorRouter(boundaryProfiles()).route({
      userInput,
      defaultExecutorName: 'codex-cli',
    });

    if (selectedExecutor === 'research-agent') {
      expect(['pi-agent', 'hermes-agent']).toContain(decision.selectedExecutor);
    } else {
      expect(decision.selectedExecutor).toBe(selectedExecutor);
    }
    expect(decision.primaryIntent).toBe(primaryIntent);
    expect(decision.matchedBoundary.length).toBeGreaterThan(0);
    if (selectedExecutor !== 'research-agent') {
      expect(decision.rejected.every(candidate => candidate.executorName !== selectedExecutor)).toBe(true);
    }
  });

  it('does not include historical success in fallback candidate scoring', () => {
    const profiles = boundaryProfiles().map(profile => profile.name === 'pi-agent'
      ? { ...profile, historicalSuccess: 1 }
      : profile);
    const decision = new ExecutorRouter(profiles).route({
      userInput: '修复这个 TypeScript bug 并跑测试',
      defaultExecutorName: 'codex-cli',
    });

    expect(decision.selectedExecutor).toBe('codex-cli');
    expect(decision.candidates.map(candidate => candidate.reason).join('\n')).not.toContain('historical=');
    expect(decision.rejected.find(candidate => candidate.executorName === 'pi-agent')?.reason)
      .toContain('repo mutation');
  });

  it('keeps fallback scores stable when only historical success changes', () => {
    const lowHistoryProfiles = boundaryProfiles().map(profile => profile.name === 'pi-agent'
      ? { ...profile, historicalSuccess: 0 }
      : profile);
    const highHistoryProfiles = boundaryProfiles().map(profile => profile.name === 'pi-agent'
      ? { ...profile, historicalSuccess: 1 }
      : profile);
    const lowHistoryDecision = new ExecutorRouter(lowHistoryProfiles).route({
      userInput: 'fix this TypeScript bug and run tests',
      defaultExecutorName: 'codex-cli',
    });
    const highHistoryDecision = new ExecutorRouter(highHistoryProfiles).route({
      userInput: 'fix this TypeScript bug and run tests',
      defaultExecutorName: 'codex-cli',
    });

    expect(highHistoryDecision.candidates.find(candidate => candidate.executorName === 'pi-agent')?.score)
      .toBe(lowHistoryDecision.candidates.find(candidate => candidate.executorName === 'pi-agent')?.score);
  });
});
