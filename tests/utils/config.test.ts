import { describe, expect, it } from 'vitest';
import { loadConfig, migrateLegacyFeishuConfigFileToGateway } from '../../src/utils/config.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { load } from 'js-yaml';

describe('loadConfig defaults', () => {
  it('uses codex as the default executor command', () => {
    const config = loadConfig('/path/that/does/not/exist.yaml');

    expect(config.executor.command).toBe('codex');
  });

  it('keeps idle timeout and legacy max duration defaults in config', () => {
    const config = loadConfig('/path/that/does/not/exist.yaml');

    expect(config.executor.timeout).toBe(300);
    expect(config.executor.max_duration).toBe(3600);
  });

  it('disables Feishu notifications by default', () => {
    const config = loadConfig('/path/that/does/not/exist.yaml');

    expect(config.notifications?.feishu?.enabled).toBe(false);
  });

  it('loads Feishu notification config from yaml', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'metaclaw-config-'));
    const configPath = resolve(dir, 'config.yaml');
    writeFileSync(configPath, [
      'notifications:',
      '  feishu:',
      '    enabled: true',
      '    webhook_url: https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
      '    secret: test-secret',
      '',
    ].join('\n'));

    const config = loadConfig(configPath);

    expect(config.notifications?.feishu).toEqual({
      enabled: true,
      webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
      secret: 'test-secret',
    });
  });

  it('migrates legacy bidirectional Feishu integration config into Gateway config', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'metaclaw-config-'));
    const configPath = resolve(dir, 'config.yaml');
    writeFileSync(configPath, [
      'integrations:',
      '  feishu:',
      '    enabled: true',
      '    app_id: cli_test',
      '    app_secret_env: TEST_FEISHU_SECRET',
      '    event_port: 9898',
      '    event_path: /feishu/callback',
      '    verification_token: token',
      '',
    ].join('\n'));

    const config = loadConfig(configPath);

    expect(config.integrations?.feishu).toEqual({
      enabled: true,
      mode: 'websocket',
      app_id: 'cli_test',
      app_secret_env: 'TEST_FEISHU_SECRET',
      event_port: 9898,
      event_path: '/feishu/callback',
      verification_token: 'token',
    });
    expect(config.gateway?.enabled).toBe(true);
    expect(config.gateway?.platforms?.feishu).toEqual({
      enabled: true,
      domain: 'feishu',
      connection_mode: 'websocket',
      app_id: 'cli_test',
      app_secret_env: 'TEST_FEISHU_SECRET',
      event_port: 9898,
      event_path: '/feishu/callback',
      verification_token: 'token',
      access: {
        dm_policy: 'pairing',
        allowed_users: [],
        group_policy: 'open',
        require_mention: true,
      },
      delivery: {
        final_markdown_mode: 'card',
        fallback_mode: 'post',
        final_file_fallback: true,
      },
    });
  });

  it('rewrites legacy Feishu integration config into canonical Gateway config on startup migration', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'metaclaw-config-migrate-'));
    const configPath = resolve(dir, 'config.yaml');
    const previousSecret = process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_APP_SECRET;
    writeFileSync(configPath, [
      'integrations:',
      '  feishu:',
      '    enabled: true',
      '    mode: webhook',
      '    app_id: cli_legacy_file',
      '    app_secret: legacy-secret',
      '    event_port: 9898',
      '    event_path: /feishu/legacy',
      '    verification_token: legacy-token',
      '  markdown_preview:',
      '    enabled: true',
      '    host: 127.0.0.1',
      '    port: 8790',
      '',
    ].join('\n'));

    try {
      expect(migrateLegacyFeishuConfigFileToGateway(configPath)).toBe(true);

      const rawConfig = load(readFileSync(configPath, 'utf-8')) as any;
      expect(rawConfig.integrations.feishu).toBeUndefined();
      expect(rawConfig.integrations.markdown_preview).toEqual({
        enabled: true,
        host: '127.0.0.1',
        port: 8790,
      });
      expect(rawConfig.gateway).toEqual({
        enabled: true,
        platforms: {
          feishu: {
            enabled: true,
            domain: 'feishu',
            connection_mode: 'webhook',
            app_id: 'cli_legacy_file',
            app_secret_env: 'FEISHU_APP_SECRET',
            event_port: 9898,
            event_path: '/feishu/legacy',
            verification_token: 'legacy-token',
            access: {
              dm_policy: 'pairing',
              allowed_users: [],
              group_policy: 'open',
              require_mention: true,
            },
            delivery: {
              final_markdown_mode: 'card',
              fallback_mode: 'post',
              final_file_fallback: true,
            },
          },
        },
      });
      expect(readFileSync(resolve(dir, '.env'), 'utf-8')).toContain('FEISHU_APP_SECRET=legacy-secret');
      expect(process.env.FEISHU_APP_SECRET).toBe('legacy-secret');
      expect(migrateLegacyFeishuConfigFileToGateway(configPath)).toBe(false);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.FEISHU_APP_SECRET;
      } else {
        process.env.FEISHU_APP_SECRET = previousSecret;
      }
    }
  });

  it('falls back to config.json in the same directory when config.yaml is missing', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'metaclaw-config-'));
    const configPath = resolve(dir, 'config.yaml');
    writeFileSync(resolve(dir, 'config.json'), JSON.stringify({
      integrations: {
        feishu: {
          enabled: true,
          app_id: 'cli_json',
          app_secret_env: 'TEST_FEISHU_SECRET',
          event_port: 9898,
          event_path: '/feishu/json',
        },
      },
    }));

    const config = loadConfig(configPath);

    expect(config.integrations?.feishu).toEqual({
      enabled: true,
      mode: 'websocket',
      app_id: 'cli_json',
      app_secret_env: 'TEST_FEISHU_SECRET',
      event_port: 9898,
      event_path: '/feishu/json',
    });
    expect(config.gateway?.platforms?.feishu?.app_id).toBe('cli_json');
    expect(config.gateway?.platforms?.feishu?.connection_mode).toBe('websocket');
  });

  it('does not expose legacy Feishu integration defaults without an old config file', () => {
    const config = loadConfig('/path/that/does/not/exist.yaml');

    expect(config.integrations?.feishu).toBeUndefined();
  });

  it('loads Markdown preview config for generated document links', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'metaclaw-config-'));
    const configPath = resolve(dir, 'config.yaml');
    writeFileSync(configPath, [
      'integrations:',
      '  markdown_preview:',
      '    enabled: true',
      '    host: 0.0.0.0',
      '    port: 8899',
      '    public_base_url: https://preview.example.com',
      '',
    ].join('\n'));

    const config = loadConfig(configPath);

    expect(config.integrations?.markdown_preview).toEqual({
      enabled: true,
      host: '0.0.0.0',
      port: 8899,
      public_base_url: 'https://preview.example.com',
    });
    expect(config.integrations?.feishu).toBeUndefined();
  });
});
