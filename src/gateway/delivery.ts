import type { GatewayOutboundMessage, GatewayPlatform, GatewaySendResult, GatewayTarget } from './types.js';

export type GatewaySender = (target: GatewayTarget, message: GatewayOutboundMessage) => Promise<GatewaySendResult>;

export interface GatewayDeliveryRouterOptions {
  localSender?: GatewaySender;
  platformSenders?: Partial<Record<GatewayPlatform, GatewaySender>>;
  homeTargets?: Partial<Record<GatewayPlatform, GatewayTarget>>;
}

export class GatewayDeliveryRouter {
  constructor(private readonly options: GatewayDeliveryRouterOptions = {}) {}

  async send(targetSpec: string, message: GatewayOutboundMessage, origin?: GatewayTarget): Promise<GatewaySendResult> {
    const target = this.resolveTarget(targetSpec, origin);
    if (target.kind === 'origin') {
      if (!origin) {
        return this.failure(target, 'origin target requested but no origin was provided');
      }
      return this.sendToResolvedTarget(origin, message);
    }
    return this.sendToResolvedTarget(target, message);
  }

  resolveTarget(targetSpec: string, origin?: GatewayTarget): GatewayTarget {
    if (targetSpec === 'origin') {
      return origin ?? { kind: 'origin' };
    }
    if (targetSpec === 'local') {
      return { kind: 'local' };
    }
    if (targetSpec === 'home') {
      return { kind: 'home' };
    }

    const platformMatch = targetSpec.match(/^([a-z]+):(.+)$/);
    if (!platformMatch) {
      return { kind: 'local' };
    }

    return {
      kind: 'platform',
      platform: platformMatch[1] as GatewayPlatform,
      id: platformMatch[2],
    };
  }

  private async sendToResolvedTarget(target: GatewayTarget, message: GatewayOutboundMessage): Promise<GatewaySendResult> {
    if (target.kind === 'local') {
      if (!this.options.localSender) {
        return { ok: true, target, method: 'noop' };
      }
      return this.options.localSender(target, message);
    }

    if (target.kind === 'home') {
      const platform = Object.keys(this.options.homeTargets ?? {})[0] as GatewayPlatform | undefined;
      const homeTarget = platform ? this.options.homeTargets?.[platform] : undefined;
      if (!homeTarget) {
        return this.failure(target, 'home channel is not configured');
      }
      return this.sendToResolvedTarget(homeTarget, message);
    }

    if (target.kind === 'platform' && target.platform) {
      const sender = this.options.platformSenders?.[target.platform];
      if (!sender) {
        return this.failure(target, `no sender registered for ${target.platform}`);
      }
      return sender(target, message);
    }

    return this.failure(target, 'unsupported target');
  }

  private failure(target: GatewayTarget, error: string): GatewaySendResult {
    return {
      ok: false,
      target,
      method: 'noop',
      error,
    };
  }
}
