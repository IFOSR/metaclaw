export function parseCliArgs(argv: string[]): { scriptPath?: string } {
  const scriptFlagIndex = argv.findIndex(arg => arg === '--script');
  if (scriptFlagIndex === -1) {
    return {};
  }

  const scriptPath = argv[scriptFlagIndex + 1];
  if (!scriptPath) {
    throw new Error('缺少脚本路径。用法: metaclaw --script <脚本文件>');
  }

  return { scriptPath };
}
