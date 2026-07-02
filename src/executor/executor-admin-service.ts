import { spawnSync } from 'child_process';
import type { AgentClass } from '../core/types.js';
import type { AgentClassService } from './agent-class-service.js';
import type { SessionPresentationService } from '../session/session-presentation-service.js';

type ExecutorRegisterWizardStep =
  | 'name'
  | 'mode'
  | 'projectUrl'
  | 'command'
  | 'args'
  | 'check'
  | 'domains'
  | 'capabilities'
  | 'confirm';

export interface PendingExecutorRegisterWizard {
  step: ExecutorRegisterWizardStep;
  profile: {
    name?: string;
    projectUrl?: string | null;
    runtimeCommand?: string;
    runtimeArgs?: string[];
    runtimeCheckCommand?: string | null;
    domains?: string[];
    capabilities?: string[];
  };
}

export interface ExecutorAdminServiceDeps {
  agentClassService: AgentClassService;
  presentation: SessionPresentationService;
  fetchText?: (url: string) => Promise<string | null>;
}

export interface ExecutorWizardHandleResult {
  handled: boolean;
  lines: string[];
}

function splitCommaList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function defaultFetchText(url: string): Promise<string | null> {
  const result = spawnSync('curl', ['-L', '--silent', '--show-error', '--max-time', '20', url], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) {
    return Promise.resolve(null);
  }
  return Promise.resolve(result.stdout);
}

export class ExecutorAdminService {
  private wizard: PendingExecutorRegisterWizard | null = null;
  private readonly fetchText: (url: string) => Promise<string | null>;

  constructor(private readonly deps: ExecutorAdminServiceDeps) {
    this.fetchText = deps.fetchText ?? defaultFetchText;
  }

  hasPendingWizard(): boolean {
    return this.wizard !== null;
  }

  startWizard(): string[] {
    this.wizard = { step: 'name', profile: {} };
    return [
      '1/8 Executor AgentClass name?',
      'Examples: codex-cli, finance-research-agent',
    ];
  }

  async handlePendingWizardInput(userInput: string): Promise<ExecutorWizardHandleResult> {
    const wizard = this.wizard;
    if (!wizard) return { handled: false, lines: [] };

    const value = userInput.trim();
    if (/^(cancel|取消)$/iu.test(value)) {
      this.wizard = null;
      return { handled: true, lines: ['Cancelled executor AgentClass registration.'] };
    }

    switch (wizard.step) {
      case 'name':
        if (!value) return { handled: true, lines: ['Name cannot be empty.'] };
        wizard.profile.name = value;
        wizard.step = 'mode';
        return { handled: true, lines: ['2/8 Type url or manual.'] };

      case 'mode':
        if (/^url$/iu.test(value)) {
          wizard.step = 'projectUrl';
          return { handled: true, lines: ['3/8 Paste the executor project URL.'] };
        }
        if (/^manual$/iu.test(value)) {
          wizard.step = 'command';
          return { handled: true, lines: ['3/8 Runtime command? Example: codex, npx, my-agent'] };
        }
        return { handled: true, lines: ['Please type url or manual.'] };

      case 'projectUrl': {
        wizard.profile.projectUrl = value;
        const suggestion = await this.inferRuntimeFromProjectUrl(value);
        if (suggestion.command) {
          wizard.profile.runtimeCommand = suggestion.command;
          wizard.profile.runtimeArgs = suggestion.args;
          wizard.profile.runtimeCheckCommand = suggestion.checkCommand;
          wizard.step = 'confirm';
          return {
            handled: true,
            lines: [
              'Runtime inferred from project URL:',
              `  command=${suggestion.command}`,
              `  args=${suggestion.args.join(' ') || '{prompt}'}`,
              `  check=${suggestion.checkCommand || '-'}`,
              'Type y to accept, n to enter manually.',
            ],
          };
        }
        wizard.step = 'command';
        return { handled: true, lines: ['Could not infer runtime. Enter runtime command.'] };
      }

      case 'command':
        if (!value) return { handled: true, lines: ['Command cannot be empty.'] };
        wizard.profile.runtimeCommand = value;
        wizard.step = 'args';
        return { handled: true, lines: ['4/8 Runtime args? Use {prompt}; type skip for no args.'] };

      case 'args':
        wizard.profile.runtimeArgs = /^skip$/iu.test(value) ? [] : value.split(/\s+/).filter(Boolean);
        wizard.step = 'check';
        return { handled: true, lines: ['5/8 Check command? Type skip to use which <command>.'] };

      case 'check':
        wizard.profile.runtimeCheckCommand = /^skip$/iu.test(value) || !value ? null : value;
        wizard.step = 'domains';
        return { handled: true, lines: ['6/8 Domains? Comma-separated, e.g. software,research'] };

      case 'domains':
        wizard.profile.domains = splitCommaList(value);
        wizard.step = 'capabilities';
        return { handled: true, lines: ['7/8 Capabilities? Comma-separated, e.g. coding,tests'] };

      case 'capabilities':
        wizard.profile.capabilities = splitCommaList(value);
        wizard.step = 'confirm';
        return {
          handled: true,
          lines: [
            this.deps.presentation.formatExecutorRegisterWizardSummary(wizard.profile),
            'Confirm registration? Type y or n.',
          ],
        };

      case 'confirm':
        if (!wizard.profile.domains) {
          if (/^n$/iu.test(value)) {
            wizard.step = 'command';
            return { handled: true, lines: ['Enter runtime command.'] };
          }
          if (!/^y$/iu.test(value)) return { handled: true, lines: ['Please type y or n.'] };
          wizard.step = 'domains';
          return { handled: true, lines: ['6/8 Domains? Comma-separated.'] };
        }
        if (/^n$/iu.test(value)) {
          this.wizard = null;
          return { handled: true, lines: ['Cancelled executor AgentClass registration.'] };
        }
        if (!/^y$/iu.test(value)) return { handled: true, lines: ['Please type y or n.'] };
        const lines = this.completeWizard(wizard);
        this.wizard = null;
        return { handled: true, lines };
    }
  }

  private completeWizard(wizard: PendingExecutorRegisterWizard): string[] {
    if (!wizard.profile.name || !wizard.profile.runtimeCommand) {
      return ['Registration failed: missing name or command.'];
    }

    const existing = this.deps.agentClassService.findByName(wizard.profile.name);
    const agentClass: AgentClass = {
      name: wizard.profile.name,
      kind: 'executor',
      domains: wizard.profile.domains ?? existing?.domains ?? [],
      capabilities: wizard.profile.capabilities ?? existing?.capabilities ?? [],
      inputTypes: existing?.inputTypes ?? ['text'],
      outputTypes: existing?.outputTypes ?? ['markdown'],
      strengths: existing?.strengths ?? [],
      weaknesses: existing?.weaknesses ?? [],
      primaryUseCases: existing?.primaryUseCases ?? [],
      avoidUseCases: existing?.avoidUseCases ?? [],
      intentAffinity: existing?.intentAffinity ?? {},
      riskLevel: existing?.riskLevel ?? 'medium',
      availability: 'available',
      historicalSuccess: existing?.historicalSuccess ?? 0.5,
      harness: existing?.harness ?? 'cli',
      model: existing?.model ?? null,
      skills: existing?.skills ?? [],
      mcpServers: existing?.mcpServers ?? [],
      plugins: existing?.plugins ?? [],
      runtimeCommand: wizard.profile.runtimeCommand,
      runtimeArgs: wizard.profile.runtimeArgs ?? [],
      runtimeCheckCommand: wizard.profile.runtimeCheckCommand ?? null,
      projectUrl: wizard.profile.projectUrl ?? existing?.projectUrl ?? null,
    };
    this.deps.agentClassService.upsert(agentClass);
    return [
      `Registered Executor AgentClass: ${agentClass.name}`,
      `-> runtime: ${agentClass.runtimeCommand} ${agentClass.runtimeArgs.join(' ')}`.trim(),
      `-> check: ${agentClass.runtimeCheckCommand || `which ${agentClass.runtimeCommand}`}`,
      '-> This executor class can now back executor work units.',
    ];
  }

  private async inferRuntimeFromProjectUrl(projectUrl: string): Promise<{
    command: string | null;
    args: string[];
    checkCommand: string | null;
  }> {
    const github = projectUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i);
    if (!github) return { command: null, args: [], checkCommand: null };

    const owner = github[1];
    const repo = github[2]?.replace(/\.git$/i, '');
    if (!owner || !repo) return { command: null, args: [], checkCommand: null };

    const packageJson = await this.fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/main/package.json`)
      ?? await this.fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/master/package.json`);
    if (packageJson) {
      try {
        const parsed = JSON.parse(packageJson) as { name?: string; bin?: string | Record<string, string> };
        const command = typeof parsed.bin === 'string'
          ? parsed.name
          : parsed.bin
            ? Object.keys(parsed.bin)[0]
            : parsed.name;
        if (command) {
          return { command, args: ['{prompt}'], checkCommand: `${command} --version` };
        }
      } catch {
        // Fall through to README heuristics.
      }
    }

    const readme = await this.fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`)
      ?? await this.fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/master/README.md`);
    const npxMatch = readme?.match(/\bnpx\s+([@a-zA-Z0-9/_-]+)(?:\s+([^\n`]*))?/);
    if (npxMatch?.[1]) {
      return {
        command: 'npx',
        args: ['-y', npxMatch[1], '{prompt}'],
        checkCommand: `npx -y ${npxMatch[1]} --version`,
      };
    }

    return { command: null, args: [], checkCommand: null };
  }
}
