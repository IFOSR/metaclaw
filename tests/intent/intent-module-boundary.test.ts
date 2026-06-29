import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

function readSource(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf-8');
}

function coreFileExists(path: string): boolean {
  return existsSync(resolve(projectRoot, path));
}

describe('intent module architecture boundaries', () => {
  it('keeps inline resource normalization in src/intent and out of core', () => {
    const implementationSource = readSource('src/intent/inline-resource-normalizer.ts');

    expect(implementationSource).toContain('export function extractInlineResourceMatches');
    expect(implementationSource).toContain('export function stripInlineResourceMatches');
    expect(coreFileExists('src/core/inline-resource-normalizer.ts')).toBe(false);
  });

  it('keeps material utilities in src/intent and out of core', () => {
    const implementationSource = readSource('src/intent/material-utils.ts');

    expect(implementationSource).toContain('export function buildMaterialSummary');
    expect(implementationSource).toContain('export function splitTaskResources');
    expect(coreFileExists('src/core/material-utils.ts')).toBe(false);
  });
});
