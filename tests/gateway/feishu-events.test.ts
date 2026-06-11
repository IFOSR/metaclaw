import { describe, expect, it } from 'vitest';
import { normalizeFeishuInboundEvent } from '../../src/gateway/feishu-events.js';

describe('normalizeFeishuInboundEvent', () => {
  it('normalizes Feishu text messages into GatewayInboundEvent', () => {
    expect(normalizeFeishuInboundEvent({
      sender: {
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_message',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{"text":"hello"}',
        mentions: [{ id: { open_id: 'ou_bot' }, name: 'MetaClaw' }],
      },
    }, {
      transport: 'websocket',
      receivedAt: '2026-06-10T00:00:00.000Z',
    })).toEqual({
      id: 'feishu:om_message',
      platform: 'feishu',
      transport: 'websocket',
      messageId: 'om_message',
      chatId: 'oc_chat',
      chatType: 'dm',
      text: 'hello',
      messageType: 'text',
      attachments: [],
      mentions: [{ id: 'ou_bot', name: 'MetaClaw' }],
      raw: expect.any(Object),
      receivedAt: '2026-06-10T00:00:00.000Z',
      userId: 'ou_user',
    });
  });

  it('rejects malformed events without message id or chat id', () => {
    expect(normalizeFeishuInboundEvent({
      message: {
        message_type: 'text',
        content: '{"text":"hello"}',
      },
    }, { transport: 'webhook' })).toBeNull();
  });
});
