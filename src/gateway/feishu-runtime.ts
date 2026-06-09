import type { Config } from '../core/types.js';
import type { MetaclawSession } from '../session/metaclaw-session.js';
import { createFeishuBridge, type FeishuBridge } from '../integrations/feishu-app.js';
import { resolveFeishuGatewayConfig } from './feishu-config.js';

type CreateFeishuBridge = (config: Config, session: MetaclawSession) => FeishuBridge | null;

export interface StartedFeishuRuntimeBridge {
  bridge: FeishuBridge;
  stop(): Promise<void>;
}

export async function startFeishuRuntimeBridge(
  config: Config,
  session: MetaclawSession,
  createBridge: CreateFeishuBridge = createFeishuBridge,
): Promise<StartedFeishuRuntimeBridge | null> {
  let bridge: FeishuBridge | null = null;
  try {
    bridge = createBridge(config, session);
  } catch (error) {
    session.appendSystemMessage(`⚠️ 飞书应用桥接未启动: ${(error as Error).message}`);
    return null;
  }

  if (!bridge) {
    return null;
  }

  const feishuMode = resolveFeishuGatewayConfig(config).connectionMode;
  try {
    await bridge.start();
    session.appendSystemMessage(
      feishuMode === 'webhook'
        ? '→ 飞书 Webhook 桥接已启动，等待飞书回调'
        : '→ 飞书长连接桥接已启动，等待飞书消息',
    );
  } catch (error) {
    session.appendSystemMessage(`⚠️ 飞书应用桥接启动失败: ${(error as Error).message}`);
    return null;
  }

  return {
    bridge,
    stop: () => bridge!.stop(),
  };
}
