import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { extractInlineResourceMatches, stripInlineResourceMatches } from '../../src/session/session-helpers.js';

describe('session helpers inline materials', () => {
  it('extracts existing local file paths from natural language input', () => {
    const fixturesDir = resolve(tmpdir(), 'metaclaw-inline-resource-helper');
    mkdirSync(fixturesDir, { recursive: true });
    const weeklyPath = resolve(fixturesDir, 'phoenix-weekly.md');
    const riskPath = resolve(fixturesDir, 'risks.md');
    writeFileSync(weeklyPath, 'weekly', 'utf-8');
    writeFileSync(riskPath, 'risks', 'utf-8');

    const matches = extractInlineResourceMatches(
      `基于 ${weeklyPath} 和 ${riskPath} 整理 Phoenix 周报`,
    );

    expect(matches.map(match => match.resolvedPath)).toEqual([weeklyPath, riskPath]);
  });

  it('extracts project-relative paths that do not start with ./', () => {
    const cwd = process.cwd();
    const relativePath = 'examples/e2e/round-7-inline-materials/fixtures/phoenix-weekly.md';

    const matches = extractInlineResourceMatches(
      `基于 ${relativePath} 整理 Phoenix 周报`,
      cwd,
    );

    expect(matches.map(match => match.resolvedPath)).toEqual([
      resolve(cwd, relativePath),
    ]);
  });

  it('extracts http and https links as inline materials', () => {
    const matches = extractInlineResourceMatches(
      '基于 https://example.com/report 和 http://example.com/risk 整理周报',
      process.cwd(),
    );

    expect(matches.map(match => match.resolvedPath)).toEqual([
      'https://example.com/report',
      'http://example.com/risk',
    ]);
  });

  it('strips extracted file paths from the visible task goal text', () => {
    const fixturesDir = resolve(tmpdir(), 'metaclaw-inline-resource-helper-strip');
    mkdirSync(fixturesDir, { recursive: true });
    const weeklyPath = resolve(fixturesDir, 'phoenix-weekly.md');
    writeFileSync(weeklyPath, 'weekly', 'utf-8');

    const matches = extractInlineResourceMatches(
      `基于 ${weeklyPath} 整理 Phoenix 周报，输出一个简短结论`,
    );
    const cleaned = stripInlineResourceMatches(
      `基于 ${weeklyPath} 整理 Phoenix 周报，输出一个简短结论`,
      matches,
    );

    expect(cleaned).not.toContain(weeklyPath);
    expect(cleaned).toBe('整理 Phoenix 周报，输出一个简短结论');
  });

  it('removes leftover connector words after stripping multiple inline paths', () => {
    const cwd = process.cwd();
    const weekly = 'examples/e2e/round-7-inline-materials/fixtures/phoenix-weekly.md';
    const risks = 'examples/e2e/round-7-inline-materials/fixtures/risks.md';
    const input = `基于 ${weekly} 和 ${risks} 整理 Phoenix 周报，输出一个简短结论`;

    const matches = extractInlineResourceMatches(input, cwd);
    const cleaned = stripInlineResourceMatches(input, matches);

    expect(cleaned).toBe('整理 Phoenix 周报，输出一个简短结论');
  });

  it('strips inline URLs from the visible task goal text', () => {
    const input = '基于 https://example.com/report 和 https://example.com/risk 整理 Phoenix 周报';
    const matches = extractInlineResourceMatches(input, process.cwd());
    const cleaned = stripInlineResourceMatches(input, matches);

    expect(cleaned).toBe('整理 Phoenix 周报');
  });
});
