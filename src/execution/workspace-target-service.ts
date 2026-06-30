import { mkdirSync } from 'fs';

export class WorkspaceTargetService {
  ensureTargets(targetPaths: string[]): void {
    for (const targetPath of targetPaths) {
      mkdirSync(targetPath, { recursive: true });
    }
  }
}
