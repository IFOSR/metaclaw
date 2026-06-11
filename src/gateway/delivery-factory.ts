import type { Config } from '../core/types.js';
import type { MetaclawSession } from '../session/metaclaw-session.js';
import { FeishuGatewayAdapter } from './feishu-adapter.js';
import { GatewayDeliveryRouter } from './delivery.js';
import type { GatewayTarget } from './types.js';

export function createGatewayDeliveryRouter(config: Config, session: MetaclawSession): GatewayDeliveryRouter {
  const feishuAdapter = new FeishuGatewayAdapter(config, session);
  const feishuHomeChannel = config.gateway?.platforms?.feishu?.home_channel;
  const homeTargets: Partial<Record<'feishu', GatewayTarget>> = feishuHomeChannel
    ? {
        feishu: {
          kind: 'platform',
          platform: 'feishu',
          id: feishuHomeChannel,
        },
      }
    : {};

  return new GatewayDeliveryRouter({
    platformSenders: {
      feishu: (target, message) => feishuAdapter.send(target, message),
    },
    homeTargets,
  });
}
