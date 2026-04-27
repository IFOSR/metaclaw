import { describe, expect, it } from 'vitest';
import { SafetyScanner } from '../../src/core/safety-scanner.js';
import { PromotionGate } from '../../src/core/promotion-gate.js';
import { ReflectionEngine } from '../../src/core/reflection-engine.js';

describe('Phase E learning core skeletons', () => {
  it('SafetyScanner redacts secrets and blocks unsafe learning candidates', () => {
    const scanner = new SafetyScanner();

    const result = scanner.scanCandidate({
      title: '部署脚本经验',
      content: '把 API_KEY=sk-live-secret123 写入配置，然后 rm -rf /tmp/demo',
    });

    expect(result.status).toBe('blocked');
    expect(result.redactedContent).not.toContain('sk-live-secret123');
    expect(result.reasons).toEqual(expect.arrayContaining(['contains_secret', 'contains_dangerous_command']));
  });

  it('PromotionGate requires review for pending candidates and refuses unsafe candidates', () => {
    const gate = new PromotionGate();

    expect(gate.evaluate({ status: 'pending', safetyStatus: 'passed', kind: 'skill' })).toMatchObject({
      decision: 'needs_review',
    });
    expect(gate.evaluate({ status: 'approved', safetyStatus: 'passed', kind: 'skill' })).toMatchObject({
      decision: 'promote',
    });
    expect(gate.evaluate({ status: 'approved', safetyStatus: 'blocked', kind: 'skill' })).toMatchObject({
      decision: 'blocked',
    });
  });

  it('ReflectionEngine creates a sanitized learning candidate from successful task evidence', () => {
    const engine = new ReflectionEngine(new SafetyScanner());

    const result = engine.reflectOnTaskCompletion({
      taskId: 'task_1',
      userInput: '修复飞书消息截断',
      executorOutput: '已定位为发送层未 chunk，修复后 npm test 通过。token=secret-token-123',
      success: true,
      createdAt: '2026-04-27T00:00:00Z',
    });

    expect(result.event.summary).toContain('修复飞书消息截断');
    expect(result.candidate).not.toBeNull();
    expect(result.candidate?.content).not.toContain('secret-token-123');
    expect(result.candidate?.status).toBe('pending');
    expect(result.candidate?.sourceTaskId).toBe('task_1');
  });
});
