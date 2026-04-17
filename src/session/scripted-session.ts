import { readFileSync } from 'fs';
import { MetaclawSession, type MetaclawSessionDeps } from './metaclaw-session.js';

export function parseScriptInputs(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

export async function runScriptedSession(
  input: { inputs: string[] } & MetaclawSessionDeps,
): Promise<{ output: string[]; exitRequested: boolean }> {
  const { inputs, ...deps } = input;
  const session = new MetaclawSession(deps);
  session.initialize();

  let exitRequested = false;
  for (const line of inputs) {
    const result = await session.submit(line, { awaitAsyncWork: true });
    if (result.exitRequested) {
      exitRequested = true;
      break;
    }
  }

  await session.waitForAsyncWork();
  return {
    output: session.getSnapshot().output,
    exitRequested,
  };
}

export async function runScriptedSessionFile(
  scriptPath: string,
  deps: MetaclawSessionDeps,
): Promise<{ output: string[]; exitRequested: boolean }> {
  const content = readFileSync(scriptPath, 'utf-8');
  return runScriptedSession({
    ...deps,
    inputs: parseScriptInputs(content),
  });
}
