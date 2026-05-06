export interface CliArgs {
  scriptPath?: string;
  gateway?: boolean;
  connect?: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const gateway = argv.includes('--gateway');
  const connect = argv.includes('--connect');
  const scriptFlagIndex = argv.findIndex(arg => arg === '--script');
  if (scriptFlagIndex === -1) {
    return { gateway, connect };
  }

  const scriptPath = argv[scriptFlagIndex + 1];
  if (!scriptPath) {
    throw new Error('缺少脚本路径。用法: metaclaw --script <脚本文件>');
  }

  return { scriptPath, gateway, connect };
}
