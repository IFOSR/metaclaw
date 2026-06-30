import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'metaclaw-smoke-test-'));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

async function loadSmokeScript() {
  return import('../../scripts/smoke-metaclaw-real-task.mjs');
}

describe('smoke-metaclaw-real-task helpers', () => {
  it('parses executor, scenario, and integer options', async () => {
    const smoke = await loadSmokeScript();

    expect(smoke.readOption(['--executor', 'pi'], '--executor')).toBe('pi');
    expect(smoke.readOption(['--scenario=python-hello'], '--scenario')).toBe('python-hello');
    expect(smoke.parseExecutorCommand('pi')).toBe('pi');
    expect(smoke.parseScenario('python-hello')).toBe('python-hello');
    expect(smoke.parsePositiveInteger('42', 10)).toBe(42);
    expect(() => smoke.parseExecutorCommand('pi;rm')).toThrow(/Invalid smoke executor command/);
    expect(() => smoke.parseScenario('unknown')).toThrow(/Invalid smoke scenario/);
  });

  it('installs Pi config under the provided executor home', async () => {
    const smoke = await loadSmokeScript();
    const sourceDir = join(tempRoot, 'pi-config');
    const targetHome = join(tempRoot, 'home');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'models.json'), '{"models":[]}');
    writeFileSync(join(sourceDir, 'settings.json'), '{"defaultModel":"test"}');

    const targetDir = smoke.installPiConfig({ sourceDir, targetHome, repoRoot: tempRoot });

    expect(targetDir).toBe(join(targetHome, '.pi', 'agent'));
    expect(existsSync(join(targetDir, 'models.json'))).toBe(true);
    expect(readFileSync(join(targetDir, 'settings.json'), 'utf-8')).toContain('defaultModel');
  });

  it('finds Python hello-world evidence independently of executor output', async () => {
    const smoke = await loadSmokeScript();
    const workdir = join(tempRoot, 'work');
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, 'hello_world.py'), 'print("hello world")\n');

    expect(smoke.findPythonHelloFile(workdir)).toBe(join(workdir, 'hello_world.py'));
  });
});
