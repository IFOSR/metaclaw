import { describe, expect, it } from 'vitest';
import { parseSkillUsageEventLine } from '../../src/executor/skill-usage-event-parser.js';

describe('SkillUsageEvent parser', () => {
  it('parses structured executor skill event lines', () => {
    const parsed = parseSkillUsageEventLine(
      'METACLAW_SKILL_EVENT {"type":"skill_started","skillName":"test-driven-development","skillVersion":"1.1.0","message":"开始按 TDD 执行","payload":{"phase":"RED"}}',
    );

    expect(parsed).toEqual({
      eventType: 'skill_started',
      skillName: 'test-driven-development',
      skillVersion: '1.1.0',
      message: '开始按 TDD 执行',
      payload: { phase: 'RED' },
    });
  });

  it('returns null for normal output, malformed JSON, or unsupported event types', () => {
    expect(parseSkillUsageEventLine('普通执行器输出')).toBeNull();
    expect(parseSkillUsageEventLine('METACLAW_SKILL_EVENT {bad json')).toBeNull();
    expect(parseSkillUsageEventLine('METACLAW_SKILL_EVENT {"type":"unknown","skillName":"x"}')).toBeNull();
  });

  it('redacts secret-like content in message and payload', () => {
    const parsed = parseSkillUsageEventLine(
      'METACLAW_SKILL_EVENT {"type":"skill_progress","skillName":"debugging","message":"api_key=sk-abc123","payload":{"token":"secret-token-value"}}',
    );

    expect(parsed?.message).toContain('[REDACTED]');
    expect(JSON.stringify(parsed?.payload)).not.toContain('secret-token-value');
  });
});
