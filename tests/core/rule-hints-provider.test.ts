import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RuleHintsProvider } from '../../src/core/rule-hints-provider.js';

describe('RuleHintsProvider', () => {
  it('wraps task status and clear regexes as hints instead of final decisions', () => {
    const provider = new RuleHintsProvider();

    expect(provider.collect('看一下当前任务状态')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'heuristic',
        kind: 'status_query',
        weight: expect.any(Number),
      }),
    ]));

    expect(provider.collect('清空所有 blocked task')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'parser',
        kind: 'clear_tasks',
        evidence: 'blocked',
      }),
    ]));
  });

  it('emits safety, priority, and resource hints without choosing a route', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'metaclaw-hints-'));
    const specPath = join(cwd, 'spec.md');
    writeFileSync(specPath, '# spec\n');
    const provider = new RuleHintsProvider(cwd);
    const hints = provider.collect('紧急：把 ./spec.md 发给客户');

    expect(hints).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'safety_guard', kind: 'risk_external_send' }),
      expect.objectContaining({ source: 'heuristic', kind: 'priority', evidence: 'urgent' }),
      expect.objectContaining({ source: 'heuristic', kind: 'resource_reference', evidence: specPath }),
    ]));
    expect(hints.every(hint => hint.weight >= 0 && hint.weight <= 1)).toBe(true);
  });

  it('uses the shared durable-work matcher instead of a second keyword list', () => {
    const provider = new RuleHintsProvider();
    const hints = provider.collect('请实现这个功能并跑 test');

    expect(hints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'heuristic',
        kind: 'durable_work',
      }),
    ]));
  });

  it('treats implementation requests with TDD wording as durable executor work', () => {
    const provider = new RuleHintsProvider();
    const hints = provider.collect('用 TDD 实现一个小功能');

    expect(hints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'heuristic',
        kind: 'durable_work',
      }),
    ]));
  });

  it('keeps half-answered continuation requests for semantic routing instead of hard resume rules', () => {
    const provider = new RuleHintsProvider();
    const hints = provider.collect('这个问题你怎么回答了一半？继续完成。');

    expect(hints).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'resume_task',
      }),
    ]));
    expect(hints).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'conversation_continuation',
      }),
    ]));
  });
});
