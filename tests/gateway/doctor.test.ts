import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import type { Config } from '../../src/core/types.js';
import { formatGatewayDoctorChecks, runGatewayDoctor } from '../../src/gateway/doctor.js';

function config(): Config {
  return {
    version: 1,
    executor: {
      command: 'codex',
      timeout: 300,
    },
    orchestration: {
      reminder_enabled: true,
      reminder_throttle: 300,
      top_k_preferences: 5,
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
    gateway: {
      enabled: true,
      platforms: {
        feishu: {
          enabled: true,
          connection_mode: 'webhook',
          app_id: 'cli_test',
          app_secret_env: 'FEISHU_SECRET',
          event_port: 8787,
          event_path: '/feishu/events',
          verification_token: 'token',
          encrypt_key_env: 'FEISHU_ENCRYPT_KEY',
          home_channel: 'oc_home',
        },
      },
    },
  };
}

describe('gateway doctor', () => {
  it('checks local Feishu Gateway configuration and secrets', () => {
    const metaclawDir = mkdtempSync(resolve(tmpdir(), 'metaclaw-doctor-'));
    const checks = runGatewayDoctor({
      config: config(),
      metaclawDir,
      env: {
        FEISHU_SECRET: 'secret',
        FEISHU_ENCRYPT_KEY: 'encrypt',
      },
    });

    expect(checks.find(check => check.name === 'gateway.feishu.app_id')?.status).toBe('ok');
    expect(checks.find(check => check.name === 'gateway.feishu.app_secret')?.status).toBe('ok');
    expect(checks.find(check => check.name === 'gateway.feishu.connection_mode')?.status).toBe('warn');
    expect(checks.find(check => check.name === 'gateway.feishu.home_channel')?.status).toBe('ok');
    expect(formatGatewayDoctorChecks(checks)).toContain('OK gateway.feishu.app_id');
  });
});
