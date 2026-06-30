import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const artifactExpectedLine = 'MetaClaw real task smoke passed.';
const scenarioNames = new Set(['artifact', 'python-hello']);

export function readOption(args, name) {
  const inline = args.find(arg => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }

  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseExecutorCommand(value) {
  const command = String(value).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(command)) {
    throw new Error(`Invalid smoke executor command: ${value}`);
  }
  return command;
}

export function parseScenario(value) {
  const scenario = String(value).trim();
  if (!scenarioNames.has(scenario)) {
    throw new Error(`Invalid smoke scenario: ${value}. Expected one of: ${[...scenarioNames].join(', ')}`);
  }
  return scenario;
}

export function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

export function installPiConfig(input = {}) {
  const repoRoot = input.repoRoot ?? process.cwd();
  const targetHome = input.targetHome ?? homedir();
  const sourceDir = input.sourceDir ?? join(repoRoot, 'docker', 'pi-config');
  const targetDir = join(targetHome, '.pi', 'agent');

  for (const fileName of ['models.json', 'settings.json']) {
    const source = join(sourceDir, fileName);
    if (!existsSync(source)) {
      throw new Error(`Missing Pi smoke config file: ${source}`);
    }
  }

  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(sourceDir, 'models.json'), join(targetDir, 'models.json'));
  copyFileSync(join(sourceDir, 'settings.json'), join(targetDir, 'settings.json'));
  return targetDir;
}

export function bootstrapExecutor(input) {
  if (input.executorCommand !== 'pi') {
    return null;
  }

  return installPiConfig({
    repoRoot: input.repoRoot,
    targetHome: input.executorHome,
  });
}

export function buildScenarioScript(scenario) {
  if (scenario === 'artifact') {
    return [
      `Create a file named smoke-result.md in the current directory. Its content must include this exact line: ${artifactExpectedLine} After creating it, tell me the file path.`,
      '/exit',
      '',
    ].join('\n');
  }

  return [
    'Create a Python file named hello_world.py in the current directory.',
    'The Python file content must include exactly this line: print("hello world")',
    'Run the file with python3 and report the stdout.',
    '/exit',
    '',
  ].join('\n');
}

export function extractArtifactPath(output) {
  const match = output.match(/-\s+([^\n]+smoke-result\.md)/);
  return match?.[1]?.trim() ?? null;
}

export function findPythonHelloFile(workdir) {
  const candidates = findFiles(workdir, filePath => filePath.endsWith('.py'));
  return candidates.find(filePath => {
    const content = readFileSync(filePath, 'utf-8');
    return content.includes('print("hello world")');
  }) ?? null;
}

export function findPythonCommand() {
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf-8' });
    if (result.status === 0) {
      return command;
    }
  }

  throw new Error('Smoke failed: neither python3 nor python is available for independent verification');
}

export function verifyArtifactScenario(input) {
  const artifactPath = extractArtifactPath(input.output);
  if (!artifactPath) {
    throw new Error('Smoke failed: MetaClaw output did not include smoke-result.md artifact path');
  }

  if (!existsSync(artifactPath)) {
    throw new Error(`Smoke failed: artifact path does not exist: ${artifactPath}`);
  }

  const content = readFileSync(artifactPath, 'utf-8');
  if (!content.includes(artifactExpectedLine)) {
    throw new Error(`Smoke failed: artifact content does not include "${artifactExpectedLine}"`);
  }

  if (/Task Memory Cards/.test(input.output) || /娴犺濮熺拋鏉跨箓閸楋紕澧栭敍鍦盿sk Memory Cards/.test(input.output)) {
    throw new Error('Smoke failed: current task was recalled as task memory during its first execution');
  }

  if (/Summary:\s*Created file:\s*``/.test(input.output) || /閹芥顩?\s*瀹告彃鍨卞鐑樻瀮娴犺绱癭`/.test(input.output)) {
    throw new Error('Smoke failed: task summary used an empty quoted artifact path');
  }

  return { artifactPath };
}

export function verifyPythonHelloScenario(input) {
  const pythonFile = findPythonHelloFile(input.workdir);
  if (!pythonFile) {
    throw new Error('Smoke failed: no Python file containing print("hello world") was found in the workdir');
  }

  const pythonCommand = findPythonCommand();
  const result = spawnSync(pythonCommand, [pythonFile], {
    cwd: input.workdir,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Smoke failed: independent Python run failed with exit code ${result.status}: ${result.stderr ?? ''}`);
  }

  if ((result.stdout ?? '').trim() !== 'hello world') {
    throw new Error(`Smoke failed: independent Python stdout was "${(result.stdout ?? '').trim()}"`);
  }

  return { artifactPath: pythonFile, pythonCommand };
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
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

export function runSmoke(rawArgs = process.argv.slice(2), env = process.env) {
  const repoRoot = resolve(process.cwd());
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    process.stdout.write(buildHelp());
    return;
  }

  const executorCommand = parseExecutorCommand(
    readOption(rawArgs, '--executor') ?? env.METACLAW_SMOKE_EXECUTOR ?? 'codex',
  );
  const scenario = parseScenario(
    readOption(rawArgs, '--scenario') ?? env.METACLAW_SMOKE_SCENARIO ?? 'artifact',
  );
  const executorTimeout = parsePositiveInteger(
    readOption(rawArgs, '--timeout') ?? env.METACLAW_SMOKE_TIMEOUT,
    executorCommand === 'pi' ? 900 : 120,
  );
  const executorMaxDuration = parsePositiveInteger(
    readOption(rawArgs, '--max-duration') ?? env.METACLAW_SMOKE_MAX_DURATION,
    executorCommand === 'pi' ? 3600 : 300,
  );

  const metaclawHome = mkdtempSync(join(tmpdir(), 'metaclaw-smoke-home-'));
  const executorHome = mkdtempSync(join(tmpdir(), 'metaclaw-smoke-executor-home-'));
  const workdir = mkdtempSync(join(tmpdir(), 'metaclaw-smoke-work-'));
  const scriptDir = mkdtempSync(join(tmpdir(), 'metaclaw-smoke-script-'));
  const scriptPath = join(scriptDir, 'script.txt');

  try {
    writeFileSync(join(metaclawHome, 'config.yaml'), [
      'version: 1',
      'executor:',
      `  command: ${executorCommand}`,
      `  timeout: ${executorTimeout}`,
      `  max_duration: ${executorMaxDuration}`,
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

    bootstrapExecutor({ executorCommand, executorHome, repoRoot });
    writeFileSync(scriptPath, buildScenarioScript(scenario));

    run('npm', ['run', 'build'], { cwd: repoRoot });
    const childEnv = {
      METACLAW_HOME: metaclawHome,
    };
    if (executorCommand === 'pi') {
      childEnv.HOME = executorHome;
      childEnv.USERPROFILE = executorHome;
    }

    const runResult = run('node', [join(repoRoot, 'dist/index.js'), '--script', scriptPath], {
      cwd: workdir,
      env: childEnv,
    });

    const output = `${runResult.stdout ?? ''}\n${runResult.stderr ?? ''}`;
    if (executorCommand === 'pi' && !output.includes('pi-agent')) {
      process.stderr.write(output);
      throw new Error('Smoke failed: expected route/execution output to mention pi-agent');
    }

    const verification = scenario === 'artifact'
      ? verifyArtifactScenario({ output, workdir })
      : verifyPythonHelloScenario({ output, workdir });

    process.stdout.write([
      'MetaClaw real task smoke passed.',
      `Executor: ${executorCommand}`,
      `Scenario: ${scenario}`,
      `Artifact: ${verification.artifactPath}`,
      `Workdir: ${workdir}`,
      '',
    ].join('\n'));
  } catch (error) {
    throw error;
  } finally {
    rmSync(metaclawHome, { recursive: true, force: true });
    rmSync(executorHome, { recursive: true, force: true });
    rmSync(scriptDir, { recursive: true, force: true });
  }
}

function buildHelp() {
  return [
    'Usage: npm run smoke:metaclaw -- [--executor <command>] [--scenario <artifact|python-hello>] [--timeout <seconds>] [--max-duration <seconds>]',
    '',
    'Environment variables:',
    '  METACLAW_SMOKE_EXECUTOR      Executor command to place in the isolated config. Defaults to codex.',
    '  METACLAW_SMOKE_SCENARIO      Scenario to run. Defaults to artifact.',
    '  METACLAW_SMOKE_TIMEOUT       Continuous no-output timeout in seconds.',
    '  METACLAW_SMOKE_MAX_DURATION  Legacy max_duration value in seconds.',
    '',
    'Examples:',
    '  npm run smoke:metaclaw',
    '  npm run smoke:metaclaw -- --executor pi --scenario python-hello',
    '  METACLAW_SMOKE_EXECUTOR=pi METACLAW_SMOKE_SCENARIO=python-hello npm run smoke:metaclaw',
    '',
  ].join('\n');
}

function findFiles(root, predicate) {
  const results = [];
  for (const entry of readdirSync(root)) {
    const entryPath = join(root, entry);
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      results.push(...findFiles(entryPath, predicate));
      continue;
    }

    if (stats.isFile() && predicate(entryPath)) {
      results.push(entryPath);
    }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSmoke();
}
