import { resolve } from 'path';
import { FeishuPairingStore } from './feishu-policy.js';

export type GatewayPairingCommand = 'list' | 'approve' | 'revoke';

export function runGatewayPairingCommand(input: {
  metaclawDir: string;
  command: GatewayPairingCommand;
  userId?: string;
  writeLine?: (line?: string) => void;
}): void {
  const writeLine = input.writeLine ?? (line => console.log(line ?? ''));
  const store = new FeishuPairingStore(resolve(input.metaclawDir, 'feishu-pairings.json'));

  if (input.command === 'list') {
    const pairings = store.list();
    writeLine('Approved users:');
    if (pairings.approvedUsers.length === 0) {
      writeLine('  (none)');
    }
    for (const user of pairings.approvedUsers) {
      writeLine(`  ${user.userId}  ${user.source}  ${user.approvedAt}`);
    }
    writeLine('Pending users:');
    if (pairings.pendingUsers.length === 0) {
      writeLine('  (none)');
    }
    for (const user of pairings.pendingUsers) {
      writeLine(`  ${user.userId}  ${user.chatId}  ${user.requestedAt}`);
    }
    return;
  }

  if (!input.userId) {
    throw new Error(`缺少用户 ID。用法: metaclaw gateway pairing ${input.command} <open_id>`);
  }

  if (input.command === 'approve') {
    const existed = store.approve(input.userId);
    writeLine(existed ? `已批准飞书用户: ${input.userId}` : `已批准飞书用户: ${input.userId}（此前不在 pending 列表）`);
    return;
  }

  const existed = store.revoke(input.userId);
  writeLine(existed ? `已撤销飞书用户: ${input.userId}` : `未找到飞书用户: ${input.userId}`);
}
