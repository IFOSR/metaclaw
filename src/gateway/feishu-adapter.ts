import type { Config } from '../core/types.js';
import type { MetaclawSession } from '../session/metaclaw-session.js';
import {
  createFeishuBridge,
  FeishuAppClient,
  resolveAppSecret,
} from '../integrations/feishu-app.js';
import { resolveFeishuGatewayConfig, toFeishuAppConfig } from './feishu-config.js';
import type {
  GatewayArtifact,
  GatewayContext,
  GatewayOutboundMessage,
  GatewayPlatformAdapter,
  GatewaySendResult,
  GatewayTarget,
} from './types.js';

export class FeishuGatewayAdapter implements GatewayPlatformAdapter {
  readonly platform = 'feishu' as const;
  private bridge: Awaited<ReturnType<typeof createFeishuBridge>> = null;
  private client: FeishuAppClient | null = null;

  constructor(
    private readonly config: Config,
    private readonly session: MetaclawSession,
  ) {}

  async start(_context: GatewayContext): Promise<void> {
    this.bridge = createFeishuBridge(this.config, this.session);
    if (!this.bridge) {
      return;
    }
    await this.bridge.start();
  }

  async stop(): Promise<void> {
    await this.bridge?.stop();
    this.bridge = null;
  }

  async send(target: GatewayTarget, message: GatewayOutboundMessage): Promise<GatewaySendResult> {
    if (target.kind !== 'platform' || target.platform !== 'feishu' || !target.id) {
      return { ok: false, target, method: 'noop', error: 'invalid Feishu target' };
    }

    try {
      const client = this.getClient();
      await client.sendMarkdownCardToChat(target.id, message.markdown ?? message.text ?? '');
      return { ok: true, target, method: 'card' };
    } catch (error) {
      return { ok: false, target, method: 'card', error: (error as Error).message };
    }
  }

  async uploadArtifact(target: GatewayTarget, artifact: GatewayArtifact): Promise<GatewaySendResult> {
    if (target.kind !== 'platform' || target.platform !== 'feishu' || !target.id) {
      return { ok: false, target, method: 'noop', error: 'invalid Feishu target' };
    }

    try {
      const client = this.getClient();
      const fileKey = await client.uploadFile(artifact.path);
      await client.sendFileToChat(target.id, fileKey);
      return { ok: true, target, method: 'file' };
    } catch (error) {
      return { ok: false, target, method: 'file', error: (error as Error).message };
    }
  }

  private getClient(): FeishuAppClient {
    if (this.client) {
      return this.client;
    }

    const resolved = resolveFeishuGatewayConfig(this.config);
    const appConfig = toFeishuAppConfig(resolved);
    const appSecret = resolveAppSecret(appConfig);
    if (!resolved.appId || !appSecret) {
      throw new Error('Feishu Gateway app credentials are not configured');
    }

    this.client = new FeishuAppClient({
      app_id: resolved.appId,
      app_secret: appSecret,
    });
    return this.client;
  }
}
