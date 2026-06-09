export interface CliArgs {
  scriptPath?: string;
  gateway?: boolean;
  connect?: boolean;
  gatewayCommand?: 'setup' | 'run' | 'start' | 'stop' | 'restart' | 'status';
}

export function parseCliArgs(argv: string[]): CliArgs {
  const gatewaySubcommand = parseGatewaySubcommand(argv);
  const gateway = argv.includes('--gateway') || gatewaySubcommand === 'run';
  const connect = argv.includes('--connect');
  const scriptFlagIndex = argv.findIndex(arg => arg === '--script');
  if (scriptFlagIndex === -1) {
    return { gateway, connect, ...(gatewaySubcommand ? { gatewayCommand: gatewaySubcommand } : {}) };
  }

  const scriptPath = argv[scriptFlagIndex + 1];
  if (!scriptPath) {
    throw new Error('缺少脚本路径。用法: metaclaw --script <脚本文件>');
  }

  return { scriptPath, gateway, connect, ...(gatewaySubcommand ? { gatewayCommand: gatewaySubcommand } : {}) };
}

function parseGatewaySubcommand(argv: string[]): CliArgs['gatewayCommand'] | undefined {
  const gatewayIndex = argv.findIndex(arg => arg === 'gateway');
  if (gatewayIndex === -1) {
    return undefined;
  }

  const command = argv[gatewayIndex + 1] ?? 'run';
  if (
    command === 'setup'
    || command === 'run'
    || command === 'start'
    || command === 'stop'
    || command === 'restart'
    || command === 'status'
  ) {
    return command;
  }
  throw new Error(`未知 gateway 子命令: ${command}`);
}
