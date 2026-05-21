import { spawnSync } from 'child_process';
import type { ExecutorProfile } from './executor-router.js';
import type { ExecutorProfileRepo } from '../storage/executor-profile-repo.js';

export interface ExecutorRegistrySeedInput {
  defaultExecutorName: string;
  availableCommands?: Set<string>;
}

const RETIRED_DEFAULT_EXECUTOR_PROFILES = ['openclaw', 'claude-code'];

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
      strengths: ['cross-session memory', 'toolset orchestration', 'skills', 'messaging gateway workflows', 'self-improving agent workflows'],
      weaknesses: ['not a dedicated coding copilot', 'broad tool surface needs task-specific gating'],
      riskLevel: 'medium',
      availability: 'available',
      historicalSuccess: 0.72,
    },
  ];
}

export function seedDefaultExecutorProfiles(
  repo: Pick<ExecutorProfileRepo, 'upsert' | 'deleteByName'>,
  input: ExecutorRegistrySeedInput,
): void {
  for (const name of RETIRED_DEFAULT_EXECUTOR_PROFILES) {
    if (name !== input.defaultExecutorName) {
      repo.deleteByName(name);
    }
  }

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
    repo.upsert({
      ...record,
      availability: available ? 'available' : 'unavailable',
    });
  }
}
