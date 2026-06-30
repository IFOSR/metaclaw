import { spawnSync } from 'child_process';
import type { ExecutorProfile } from '../core/executor-router.js';
import type { ExecutorProfileService } from './executor-profile-service.js';
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
  profileService: ExecutorProfileService;
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
    this.wizard = {
      step: 'name',
      profile: {},
    };
    return [
      '1/8 Executor 名称是什么？',
      '示例：my-agent、pi-agent、finance-research-agent',
    ];
  }

  async handlePendingWizardInput(userInput: string): Promise<ExecutorWizardHandleResult> {
    const wizard = this.wizard;
    if (!wizard) return { handled: false, lines: [] };

    const value = userInput.trim();
    if (/^(cancel|取消)$/iu.test(value)) {
      this.wizard = null;
      return { handled: true, lines: ['已取消 Executor 注册向导'] };
    }

    switch (wizard.step) {
      case 'name':
        if (!value) {
          return { handled: true, lines: ['名称不能为空。请输入 Executor 名称，或输入 cancel 取消。'] };
        }
        wizard.profile.name = value;
        wizard.step = 'mode';
        return {
          handled: true,
          lines: [
            '2/8 你想怎么补全运行信息？',
            '输入 url：我给项目地址，MetaClaw 尝试推断安装/运行信息',
            '输入 manual：我手动填写 command、args、check',
          ],
        };

      case 'mode':
        if (/^url$/iu.test(value)) {
          wizard.step = 'projectUrl';
          return { handled: true, lines: ['3/8 请粘贴 Executor 项目地址（例如 GitHub URL）。'] };
        }
        if (/^manual$/iu.test(value)) {
          wizard.step = 'command';
          return { handled: true, lines: ['3/8 本机运行这个 Executor 的命令是什么？示例：codex、my-agent、npx'] };
        }
        return { handled: true, lines: ['请输入 url 或 manual。'] };

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
              '→ 已从项目地址推断出候选运行方式：',
              `  command=${suggestion.command}`,
              `  args=${suggestion.args.join(' ') || '{prompt}'}`,
              `  check=${suggestion.checkCommand || '-'}`,
              '如果正确，输入 y；如果不正确，输入 n 后手动填写。',
            ],
          };
        }
        wizard.step = 'command';
        return {
          handled: true,
          lines: [
            '→ 没能从项目地址可靠推断非交互运行方式，切换为手动填写。',
            '4/8 本机运行这个 Executor 的命令是什么？示例：codex、my-agent、npx',
          ],
        };
      }

      case 'command':
        if (!value) {
          return { handled: true, lines: ['command 不能为空。示例：my-agent'] };
        }
        wizard.profile.runtimeCommand = value;
        wizard.step = 'args';
        return {
          handled: true,
          lines: [
            '4/8 非交互运行参数是什么？用 {prompt} 表示 MetaClaw 传入的任务提示。',
            '示例：exec --prompt {prompt}',
            '如果命令会把最后一个参数当 prompt，可直接输入 skip。',
          ],
        };

      case 'args':
        wizard.profile.runtimeArgs = /^skip$/iu.test(value) ? [] : value.split(/\s+/).filter(Boolean);
        wizard.step = 'check';
        return {
          handled: true,
          lines: [
            '5/8 安装检测命令是什么？',
            '示例：my-agent --version',
            '如果不填，将用 which <command> 检测；输入 skip 跳过自定义检测。',
          ],
        };

      case 'check':
        wizard.profile.runtimeCheckCommand = /^skip$/iu.test(value) || !value ? null : value;
        wizard.step = 'domains';
        return { handled: true, lines: ['6/8 适合哪些领域？用逗号分隔。示例：software,research,finance'] };

      case 'domains':
        wizard.profile.domains = splitCommaList(value);
        wizard.step = 'capabilities';
        return { handled: true, lines: ['7/8 具备哪些能力？用逗号分隔。示例：coding,tests,report_generation'] };

      case 'capabilities':
        wizard.profile.capabilities = splitCommaList(value);
        wizard.step = 'confirm';
        return {
          handled: true,
          lines: [
            this.deps.presentation.formatExecutorRegisterWizardSummary(wizard.profile),
            '确认注册？输入 y 注册，输入 n 取消。',
          ],
        };

      case 'confirm':
        if (!wizard.profile.domains) {
          if (/^n$/iu.test(value)) {
            wizard.step = 'command';
            return { handled: true, lines: ['请手动填写运行命令。示例：my-agent、npx'] };
          }
          if (!/^y$/iu.test(value)) {
            return { handled: true, lines: ['请输入 y 或 n。'] };
          }
          wizard.step = 'domains';
          return { handled: true, lines: ['6/8 适合哪些领域？用逗号分隔。示例：software,research,finance'] };
        }

        if (/^n$/iu.test(value)) {
          this.wizard = null;
          return { handled: true, lines: ['已取消 Executor 注册'] };
        }
        if (!/^y$/iu.test(value)) {
          return { handled: true, lines: ['请输入 y 或 n。'] };
        }
        const lines = this.completeWizard(wizard);
        this.wizard = null;
        return { handled: true, lines };
    }
  }

  private completeWizard(wizard: PendingExecutorRegisterWizard): string[] {
    if (!wizard.profile.name || !wizard.profile.runtimeCommand) {
      return ['注册失败：缺少 name 或 command。请重新执行 /executor register wizard。'];
    }

    const existing = this.deps.profileService.findByName(wizard.profile.name);
    const profile: ExecutorProfile = {
      name: wizard.profile.name,
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
      runtimeCommand: wizard.profile.runtimeCommand,
      runtimeArgs: wizard.profile.runtimeArgs ?? [],
      runtimeCheckCommand: wizard.profile.runtimeCheckCommand ?? null,
      projectUrl: wizard.profile.projectUrl ?? existing?.projectUrl ?? null,
    };
    this.deps.profileService.upsert(profile);
    const runtimeArgs = profile.runtimeArgs ?? [];
    return [
      `已注册 Executor：${profile.name}`,
      `→ runtime: ${profile.runtimeCommand} ${runtimeArgs.join(' ')}`.trim(),
      `→ check: ${profile.runtimeCheckCommand || `which ${profile.runtimeCommand}`}`,
      '→ 调度前会执行安装检测；检测失败会自动标记 unavailable 并回退默认 Executor。',
    ];
  }

  private async inferRuntimeFromProjectUrl(projectUrl: string): Promise<{
    command: string | null;
    args: string[];
    checkCommand: string | null;
  }> {
    const github = projectUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i);
    if (!github) {
      return { command: null, args: [], checkCommand: null };
    }

    const owner = github[1];
    const repo = github[2]?.replace(/\.git$/i, '');
    if (!owner || !repo) {
      return { command: null, args: [], checkCommand: null };
    }

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
          return {
            command,
            args: ['{prompt}'],
            checkCommand: `${command} --version`,
          };
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
