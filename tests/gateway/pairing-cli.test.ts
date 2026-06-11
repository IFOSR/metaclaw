import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { FeishuPairingStore } from '../../src/gateway/feishu-policy.js';
import { runGatewayPairingCommand } from '../../src/gateway/pairing-cli.js';

describe('gateway pairing CLI', () => {
  it('lists, approves, and revokes Feishu users', () => {
    const metaclawDir = mkdtempSync(resolve(tmpdir(), 'metaclaw-pairing-cli-'));
    const store = new FeishuPairingStore(resolve(metaclawDir, 'feishu-pairings.json'));
    store.addPending('ou_pending', 'oc_chat');
    const lines: string[] = [];

    runGatewayPairingCommand({
      metaclawDir,
      command: 'list',
      writeLine: line => lines.push(line ?? ''),
    });
    expect(lines.join('\n')).toContain('ou_pending');

    runGatewayPairingCommand({
      metaclawDir,
      command: 'approve',
      userId: 'ou_pending',
      writeLine: line => lines.push(line ?? ''),
    });
    expect(store.isApproved('ou_pending')).toBe(true);

    runGatewayPairingCommand({
      metaclawDir,
      command: 'revoke',
      userId: 'ou_pending',
      writeLine: line => lines.push(line ?? ''),
    });
    expect(store.isApproved('ou_pending')).toBe(false);
    expect(lines.join('\n')).toContain('已撤销飞书用户: ou_pending');
  });
});
