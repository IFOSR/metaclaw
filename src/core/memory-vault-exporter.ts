import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { MemoryAuditEventRepo } from '../storage/memory-audit-event-repo.js';
import type { MemoryEngine } from './memory-engine.js';

export interface MemoryVaultExportResult {
  vaultDir: string;
  preferenceCount: number;
  evidenceCount: number;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function defaultVaultDir(): string {
  return resolve(homedir(), '.metaclaw', 'vault');
}

function yamlString(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(value);
}

export class MemoryVaultExporter {
  constructor(
    private db: Database.Database,
    private memoryEngine: MemoryEngine,
  ) {}

  export(input: { vaultDir?: string } = {}): MemoryVaultExportResult {
    const vaultDir = input.vaultDir ?? defaultVaultDir();
    const dirs = [
      '',
      'preferences',
      'profiles',
      'profiles/projects',
      'profiles/contacts',
      'profiles/executors',
      'tasks',
      'decisions',
      'evidence',
      'skills',
      'timelines',
    ];
    for (const dir of dirs) {
      ensureDir(join(vaultDir, dir));
    }

    const preferences = this.memoryEngine.list({ status: 'confirmed' });
    const auditRepo = new MemoryAuditEventRepo(this.db);
    const events = auditRepo.findRecent(1000);

    writeFileSync(join(vaultDir, 'README.md'), [
      '# MetaClaw Memory Vault',
      '',
      'This vault is a one-way export from SQLite. SQLite remains the runtime source of truth.',
      '',
      `- preferences=${preferences.length}`,
      `- evidence=${events.length}`,
    ].join('\n'));

    for (const preference of preferences) {
      const preferenceEvents = events.filter(event => event.memoryId === preference.id);
      writeFileSync(join(vaultDir, 'preferences', `${preference.id}.md`), [
        '---',
        `id: ${preference.id}`,
        `kind: preference`,
        `scope: ${preference.scope}`,
        `subject: ${yamlString(preference.subject)}`,
        `confidence: ${preference.confidence}`,
        `risk: low`,
        'evidence:',
        ...preferenceEvents.map(event => `  - ${event.id}`),
        '---',
        '',
        `# ${preference.content.slice(0, 40)}`,
        '',
        preference.content,
      ].join('\n'));
    }

    for (const event of events) {
      writeFileSync(join(vaultDir, 'evidence', `${event.id}.md`), [
        '---',
        `id: ${event.id}`,
        `memoryId: ${event.memoryId}`,
        `taskId: ${yamlString(event.taskId)}`,
        `action: ${event.action}`,
        `score: ${event.score ?? 'null'}`,
        `judgeSource: ${event.judgeSource}`,
        `createdAt: ${event.createdAt}`,
        '---',
        '',
        `# Evidence ${event.id}`,
        '',
        event.reason,
        '',
        '```json',
        JSON.stringify(event.evidence, null, 2),
        '```',
      ].join('\n'));
    }

    writeFileSync(join(vaultDir, 'timelines', 'memory.md'), [
      '# Memory Timeline',
      '',
      ...events.map(event => `- ${event.createdAt} ${event.action} ${event.memoryId} task=${event.taskId ?? 'none'} score=${event.score ?? 'n/a'}`),
    ].join('\n'));

    writeFileSync(join(vaultDir, 'profiles', 'user.md'), [
      '# User Profile',
      '',
      `长期记忆 ${preferences.length} 条。`,
      '',
      ...preferences.map(preference => `- [${preference.scope}] ${preference.content}`),
    ].join('\n'));

    const projectSubjects = Array.from(new Set(preferences
      .filter(preference => preference.scope === 'project' && preference.subject)
      .map(preference => preference.subject as string)));
    for (const subject of projectSubjects) {
      const projectPreferences = preferences.filter(preference => preference.scope === 'project' && preference.subject === subject);
      writeFileSync(join(vaultDir, 'profiles', 'projects', `${subject}.md`), [
        `# Project ${subject}`,
        '',
        ...projectPreferences.map(preference => `- ${preference.content}`),
      ].join('\n'));
    }

    return {
      vaultDir,
      preferenceCount: preferences.length,
      evidenceCount: events.length,
    };
  }

  status(input: { vaultDir?: string } = {}): MemoryVaultExportResult {
    const vaultDir = input.vaultDir ?? defaultVaultDir();
    return {
      vaultDir,
      preferenceCount: this.memoryEngine.list({ status: 'confirmed' }).length,
      evidenceCount: new MemoryAuditEventRepo(this.db).findRecent(1000).length,
    };
  }
}
