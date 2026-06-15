import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const metaclawHome = mkdtempSync(join(tmpdir(), 'metaclaw-smoke-home-'));
const workdir = mkdtempSync(join(tmpdir(), 'metaclaw-smoke-work-'));
const scriptPath = join(mkdtempSync(join(tmpdir(), 'metaclaw-smoke-script-')), 'script.txt');
const expectedLine = 'MetaClaw real task smoke passed.';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }

  return result;
}

try {
  writeFileSync(join(metaclawHome, 'config.yaml'), [
    'version: 1',
    'executor:',
    '  command: codex',
    '  timeout: 120',
    '  max_duration: 300',
    'orchestration:',
    '  reminder_enabled: false',
    '  reminder_throttle: 300',
    '  top_k_preferences: 5',
    '  blocked_recheck_enabled: false',
    'ui:',
    '  language: zh-CN',
    '  dashboard_on_start: false',
    'integrations:',
    '  markdown_preview:',
    '    enabled: false',
    'notifications:',
    '  feishu:',
    '    enabled: false',
    '',
  ].join('\n'));

  writeFileSync(scriptPath, [
    `请在当前目录创建文件 smoke-result.md，内容必须包含这一行：${expectedLine} 完成后告诉我文件路径。`,
    '/exit',
    '',
  ].join('\n'));

  run('npm', ['run', 'build']);
  const runResult = run('node', [join(repoRoot, 'dist/index.js'), '--script', scriptPath], {
    cwd: workdir,
    env: {
      METACLAW_HOME: metaclawHome,
    },
  });

  const output = `${runResult.stdout ?? ''}\n${runResult.stderr ?? ''}`;
  const artifactMatch = output.match(/-\s+(\/[^\n]+smoke-result\.md)/);
  if (!artifactMatch?.[1]) {
    process.stderr.write(output);
    throw new Error('Smoke failed: MetaClaw output did not include smoke-result.md artifact path');
  }

  const artifactPath = artifactMatch[1].trim();
  if (!existsSync(artifactPath)) {
    process.stderr.write(output);
    throw new Error(`Smoke failed: artifact path does not exist: ${artifactPath}`);
  }

  const content = readFileSync(artifactPath, 'utf-8');
  if (!content.includes(expectedLine)) {
    process.stderr.write(output);
    throw new Error(`Smoke failed: artifact content does not include "${expectedLine}"`);
  }

  if (/任务记忆卡片（Task Memory Cards/.test(output)) {
    process.stderr.write(output);
    throw new Error('Smoke failed: current task was recalled as task memory during its first execution');
  }

  if (/摘要:\s*已创建文件：``/.test(output)) {
    process.stderr.write(output);
    throw new Error('Smoke failed: task summary used an empty quoted artifact path');
  }

  process.stdout.write([
    'MetaClaw real task smoke passed.',
    `Artifact: ${artifactPath}`,
    `Workdir: ${workdir}`,
    '',
  ].join('\n'));
} finally {
  rmSync(metaclawHome, { recursive: true, force: true });
  rmSync(scriptPath.split('/').slice(0, -1).join('/'), { recursive: true, force: true });
}
