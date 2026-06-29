import { spawnSync } from 'child_process';
import type { ExecutorProfile } from '../core/executor-router.js';
import type { ExecutorProfileRepo } from '../storage/executor-profile-repo.js';

export interface ExecutorRegistrySeedInput {
  defaultExecutorName: string;
  availableCommands?: Set<string>;
}

const RETIRED_DEFAULT_EXECUTOR_PROFILES = ['openclaw', 'claude-code', 'deepseek-tui'];

function commandExists(command: string): boolean {
  try {
    return spawnSync('which', [command]).status === 0;
  } catch {
    return false;
  }
}

function knownProfiles(defaultExecutorName: string): Array<ExecutorProfile & { command: string }> {
  return [
    {
      command: 'codex',
      name: 'codex-cli',
      domains: ['software', 'repo', 'terminal', 'code_review'],
      capabilities: ['coding', 'tests', 'debugging', 'refactor', 'code_review', 'sandboxed_execution', 'noninteractive_execution'],
      inputTypes: ['text', 'files'],
      outputTypes: ['code', 'patch', 'markdown', 'review'],
      strengths: ['local repository editing', 'test execution', 'bug fixing', 'code review', 'TDD implementation'],
      weaknesses: ['non-code business workflows', 'messaging gateway operations'],
      primaryUseCases: ['实现这个功能', '修这个 bug', '跑测试并修复失败', '重构这个模块', '给这个 PR 做代码审查', '把结果写入文件/patch'],
      avoidUseCases: ['市场调研', '长篇商业报告', '个人助理工作流', '消息网关', '长期记忆自动化'],
      intentAffinity: {
        repo_execution: 1,
        technical_reasoning: 0.45,
        research_workflow: 0.15,
        memory_agent_ops: 0.1,
        conversation_or_control: 0,
      },
      riskLevel: 'medium',
      availability: 'available',
      historicalSuccess: defaultExecutorName === 'codex-cli' ? 0.85 : 0.75,
    },
    {
      command: 'claude',
      name: 'claude-code',
      domains: ['software', 'architecture', 'analysis', 'repo'],
      capabilities: ['coding', 'architecture_review', 'long_context_analysis', 'subagents', 'mcp', 'workflow_automation', 'ci_noninteractive'],
      inputTypes: ['text', 'files'],
      outputTypes: ['code', 'markdown', 'plan', 'json'],
      strengths: ['architecture reasoning', 'large codebase analysis', 'custom subagents', 'MCP-backed developer workflows'],
      weaknesses: ['may require subscription/session state', 'not a messaging gateway runtime'],
      riskLevel: 'medium',
      availability: 'available',
      historicalSuccess: defaultExecutorName === 'claude-code' ? 0.85 : 0.78,
    },
    {
      command: 'hermes',
      name: 'hermes-agent',
      domains: ['personal_assistant', 'research', 'automation', 'messaging', 'memory', 'agent_ops'],
      capabilities: ['persistent_memory', 'research', 'multi_tool', 'mcp', 'skill_runtime', 'messaging_gateway', 'workflow_automation', 'session_management', 'code_execution'],
      inputTypes: ['text', 'image'],
      outputTypes: ['markdown', 'report'],
      strengths: ['research workflows', 'cross-session memory', 'toolset orchestration', 'skills', 'messaging gateway workflows', 'self-improving agent workflows'],
      weaknesses: ['not a dedicated coding copilot', 'broad tool surface needs task-specific gating'],
      primaryUseCases: ['调研并输出报告', '整理多份资料', '结合长期记忆', '多工具调用', '自动化工作流', '消息网关', '通知', '跨 session 追踪'],
      avoidUseCases: ['纯本地代码实现', '单仓库 bugfix', '数学推导', '算法推理'],
      intentAffinity: {
        repo_execution: 0.15,
        technical_reasoning: 0.25,
        research_workflow: 1,
        memory_agent_ops: 1,
        conversation_or_control: 0,
      },
      riskLevel: 'medium',
      availability: 'available',
      historicalSuccess: 0.72,
    },
    {
      command: 'pi',
      name: 'pi-agent',
      domains: ['research', 'automation', 'agent_ops', 'reporting', 'analysis'],
      capabilities: ['research', 'multi_tool', 'workflow_automation', 'agentic_cli', 'report_generation', 'code_execution'],
      inputTypes: ['text', 'files'],
      outputTypes: ['markdown', 'report', 'analysis'],
      strengths: ['research workflows', 'report generation', 'agentic CLI execution', 'multi-step information synthesis'],
      weaknesses: ['not the default local repo mutation owner', 'requires @earendil-works/pi-coding-agent installation and authentication'],
      primaryUseCases: ['调研并输出报告', '市场调研', '竞品调研', '公司研究', '产品研究', '整理多份资料', 'research report', 'AI agent 调研'],
      avoidUseCases: ['纯本地代码实现', '单仓库 bugfix', '消息网关发送', '需要 DeepSeek 指定模型推理'],
      intentAffinity: {
        repo_execution: 0.2,
        technical_reasoning: 0.45,
        research_workflow: 1,
        memory_agent_ops: 0.65,
        conversation_or_control: 0,
      },
      riskLevel: 'medium',
      availability: 'available',
      historicalSuccess: defaultExecutorName === 'pi-agent' ? 0.85 : 0.78,
    },
    {
      command: 'deepseek-tui',
      name: 'deepseek-tui',
      domains: ['software', 'repo', 'terminal', 'code_review', 'reasoning', 'algorithm', 'math', 'chinese_analysis'],
      capabilities: ['coding', 'tests', 'debugging', 'refactor', 'code_review', 'code_execution', 'deepseek_reasoning', 'agentic_tui', 'mcp', 'skill_runtime'],
      inputTypes: ['text', 'files'],
      outputTypes: ['code', 'patch', 'markdown', 'review', 'analysis'],
      strengths: [
        'DeepSeek model reasoning',
        'Chinese technical analysis',
        'terminal-native coding agent workflows',
        'non-interactive exec mode with tools',
        'code review over git diffs',
        'Python and Node execution tools',
      ],
      weaknesses: ['requires DeepSeek provider credentials', 'not a messaging gateway runtime'],
      primaryUseCases: ['用 DeepSeek 分析', '复杂算法推理', '数学推导', '中文技术分析', '分析这段代码的边界条件', '深度架构分析'],
      avoidUseCases: ['大规模确定性 repo 编辑', '多来源商业调研', '消息网关工作流', '长期记忆自动化'],
      intentAffinity: {
        repo_execution: 0.55,
        technical_reasoning: 1,
        research_workflow: 0.25,
        memory_agent_ops: 0.15,
        conversation_or_control: 0,
      },
      riskLevel: 'medium',
      availability: 'available',
      historicalSuccess: defaultExecutorName === 'deepseek-tui' ? 0.85 : 0.76,
    },
  ];
}

export function seedDefaultExecutorProfiles(
  repo: Pick<ExecutorProfileRepo, 'upsert' | 'findByName'>,
  input: ExecutorRegistrySeedInput,
): void {
  const availableCommands = input.availableCommands;
  for (const profile of knownProfiles(input.defaultExecutorName)) {
    if (RETIRED_DEFAULT_EXECUTOR_PROFILES.includes(profile.name) && profile.name !== input.defaultExecutorName) {
      continue;
    }

    const available = availableCommands
      ? availableCommands.has(profile.command)
      : commandExists(profile.command);
    if (!available && profile.name !== input.defaultExecutorName) {
      continue;
    }

    const { command: _command, ...record } = profile;
    const existing = repo.findByName(profile.name);
    if (existing?.availability === 'unavailable') {
      continue;
    }

    repo.upsert({
      ...record,
      availability: available ? 'available' : 'unavailable',
    });
  }
}
