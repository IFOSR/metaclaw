import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { GatewayAuditLog } from '../../src/gateway/audit.js';

describe('GatewayAuditLog', () => {
  it('writes delivery audit records as json lines', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'metaclaw-gateway-audit-'));
    const auditPath = resolve(dir, 'gateway-audit.jsonl');
    const audit = new GatewayAuditLog(auditPath);

    audit.record({
      ts: '2026-06-09T00:00:00.000Z',
      platform: 'feishu',
      kind: 'final',
      target: 'oc_chat',
      method: 'card',
      ok: true,
      requestId: 'om_message',
      reason: 'sent',
      chunkIndex: 0,
      chunkCount: 2,
    });

    expect(readFileSync(auditPath, 'utf-8').trim()).toBe(JSON.stringify({
      ts: '2026-06-09T00:00:00.000Z',
      platform: 'feishu',
      kind: 'final',
      target: 'oc_chat',
      method: 'card',
      ok: true,
      requestId: 'om_message',
      reason: 'sent',
      chunkIndex: 0,
      chunkCount: 2,
    }));
  });
});
