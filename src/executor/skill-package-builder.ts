import type { LearningCandidateRecord } from '../storage/learning-candidate-repo.js';
import { SafetyScanner } from '../core/safety-scanner.js';

export type ExecutorSkillPackageKind = 'skill' | 'skill_patch';

export interface ExecutorSkillPackageFile {
  path: string;
  content: string;
}

export interface ExecutorSkillPackage {
  id: string;
  candidateId: string;
  name: string;
  version: string;
  kind: ExecutorSkillPackageKind;
  bodyMarkdown: string;
  files: ExecutorSkillPackageFile[];
  safetyStatus: 'passed';
  createdAt: string;
}

export interface BuildExecutorSkillPackageOptions {
  now?: string;
  files?: ExecutorSkillPackageFile[];
}

const ALLOWED_FILE_PREFIXES = ['references/', 'templates/', 'scripts/', 'assets/'];
const CREDENTIAL_PATH_PATTERNS = [/(^|\/)\.env(?:\.|$)/i, /(^|\/)\.ssh(?:\/|$)/i, /(credential|credentials|secret|secrets|token|password|api[_-]?key)/i];
const SECRET_TEXT_PATTERNS = [/\bsk-[A-Za-z0-9_-]{8,}\b/g, /\b(api[_-]?key|token|password|secret)\s*=\s*[^\s]+/gi];

function slugifySkillName(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'executor-skill';
}

function assertNoSecretText(text: string, location: string): void {
  const scanner = new SafetyScanner();
  const result = scanner.scanCandidate({ title: location, content: text });
  if (result.status === 'blocked' && result.reasons.includes('contains_secret')) {
    throw new Error(`Cannot build executor skill package: ${location} contains secret-like content`);
  }

  for (const pattern of SECRET_TEXT_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      throw new Error(`Cannot build executor skill package: ${location} contains secret-like content`);
    }
  }
}

function assertSafePackageFile(file: ExecutorSkillPackageFile): void {
  if (!file.path || file.path.startsWith('/') || file.path.includes('..') || file.path.includes('\\')) {
    throw new Error(`Unsafe executor skill package file path: ${file.path}`);
  }

  if (!ALLOWED_FILE_PREFIXES.some(prefix => file.path.startsWith(prefix))) {
    throw new Error(`Unsafe executor skill package file path: ${file.path}`);
  }

  if (CREDENTIAL_PATH_PATTERNS.some(pattern => pattern.test(file.path))) {
    throw new Error(`Credential-like executor skill package file path is blocked: ${file.path}`);
  }

  assertNoSecretText(file.content, `supporting file ${file.path}`);
}

function renderSkillMarkdown(candidate: LearningCandidateRecord): string {
  return `# ${candidate.title}\n\n${candidate.content}\n`;
}

function resolvePackageKind(candidate: LearningCandidateRecord): ExecutorSkillPackageKind {
  if (candidate.kind === 'skill') {
    return 'skill';
  }

  if (candidate.kind === 'skill_patch') {
    if (!candidate.promotedAssetId) {
      throw new Error('Skill patch candidates require a target promotedAssetId');
    }
    return 'skill_patch';
  }

  throw new Error('Only skill or skill_patch learning candidates can be promoted to executor skill packages');
}

function resolvePackageVersion(candidate: LearningCandidateRecord, kind: ExecutorSkillPackageKind): string {
  if (kind === 'skill_patch') {
    const requestedVersion = candidate.reviewNote?.match(/version\s*[:=]\s*([^\s]+)/i)?.[1];
    return requestedVersion ?? '1.0.1';
  }

  return '1.0.0';
}

export function buildExecutorSkillPackage(
  candidate: LearningCandidateRecord,
  options: BuildExecutorSkillPackageOptions = {},
): ExecutorSkillPackage {
  const kind = resolvePackageKind(candidate);
  const name = kind === 'skill_patch' ? candidate.promotedAssetId! : slugifySkillName(candidate.title);
  const version = resolvePackageVersion(candidate, kind);

  if (candidate.status !== 'approved') {
    throw new Error('Only approved learning candidates can be promoted to executor skill packages');
  }

  if (candidate.safetyStatus !== 'passed') {
    throw new Error('Only candidates with passed safety status can be promoted to executor skill packages');
  }

  const bodyMarkdown = renderSkillMarkdown(candidate);
  assertNoSecretText(`${candidate.title}\n${candidate.content}`, 'candidate content');
  const files = options.files ?? [];
  for (const file of files) {
    assertSafePackageFile(file);
  }

  return {
    id: `pkg_${candidate.id}`,
    candidateId: candidate.id,
    name,
    version,
    kind,
    bodyMarkdown,
    files,
    safetyStatus: 'passed',
    createdAt: options.now ?? new Date().toISOString(),
  };
}
