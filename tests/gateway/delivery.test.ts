import { describe, expect, it, vi } from 'vitest';
import { GatewayDeliveryRouter } from '../../src/gateway/delivery.js';
import type { GatewayOutboundMessage } from '../../src/gateway/types.js';

const message: GatewayOutboundMessage = {
  kind: 'final',
  markdown: 'hello',
  visibility: 'user',
  fallbackPolicy: 'split',
};

describe('GatewayDeliveryRouter', () => {
  it('routes explicit platform targets', async () => {
    const feishuSender = vi.fn().mockResolvedValue({
      ok: true,
      target: { kind: 'platform', platform: 'feishu', id: 'oc_chat' },
      method: 'card',
    });
    const router = new GatewayDeliveryRouter({
      platformSenders: {
        feishu: feishuSender,
      },
    });

    const result = await router.send('feishu:oc_chat', message);

    expect(result.ok).toBe(true);
    expect(feishuSender).toHaveBeenCalledWith({
      kind: 'platform',
      platform: 'feishu',
      id: 'oc_chat',
    }, message);
  });

  it('resolves origin and home targets', async () => {
    const feishuSender = vi.fn().mockResolvedValue({
      ok: true,
      target: { kind: 'platform', platform: 'feishu', id: 'oc_home' },
      method: 'card',
    });
    const router = new GatewayDeliveryRouter({
      platformSenders: {
        feishu: feishuSender,
      },
      homeTargets: {
        feishu: { kind: 'platform', platform: 'feishu', id: 'oc_home' },
      },
    });

    await router.send('origin', message, { kind: 'platform', platform: 'feishu', id: 'oc_origin' });
    await router.send('home', message);

    expect(feishuSender).toHaveBeenNthCalledWith(1, {
      kind: 'platform',
      platform: 'feishu',
      id: 'oc_origin',
    }, message);
    expect(feishuSender).toHaveBeenNthCalledWith(2, {
      kind: 'platform',
      platform: 'feishu',
      id: 'oc_home',
    }, message);
  });
});
