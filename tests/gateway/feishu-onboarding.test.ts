import { describe, expect, it, vi } from 'vitest';
import { registerFeishuBotByQr } from '../../src/gateway/feishu-onboarding.js';

describe('Feishu QR onboarding', () => {
  it('runs init, begin, poll, and bot probe for QR registration', async () => {
    let now = 0;
    const postForm = vi.fn()
      .mockResolvedValueOnce({ supported_auth_methods: ['client_secret'] })
      .mockResolvedValueOnce({
        device_code: 'device_code_test',
        verification_uri_complete: 'https://accounts.feishu.cn/verify?code=abc',
        user_code: 'ABCD',
        interval: 5,
        expire_in: 600,
      })
      .mockResolvedValueOnce({ error: 'authorization_pending' })
      .mockResolvedValueOnce({
        client_id: 'cli_test',
        client_secret: 'secret_test',
        user_info: {
          open_id: 'ou_user',
          tenant_brand: 'feishu',
        },
      });
    const postJson = vi.fn().mockResolvedValue({
      code: 0,
      tenant_access_token: 'tenant_token',
    });
    const getJson = vi.fn().mockResolvedValue({
      code: 0,
      bot: {
        app_name: 'MetaClaw Bot',
        open_id: 'ou_bot',
      },
    });
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const renderQr = vi.fn();

    const result = await registerFeishuBotByQr({
      deps: {
        postForm,
        postJson,
        getJson,
        sleep,
        nowMs: () => now,
        renderQr,
      },
    });

    expect(result).toEqual({
      appId: 'cli_test',
      appSecret: 'secret_test',
      domain: 'feishu',
      userOpenId: 'ou_user',
      botName: 'MetaClaw Bot',
      botOpenId: 'ou_bot',
    });
    expect(postForm.mock.calls[0]?.[0]).toBe('https://accounts.feishu.cn/oauth/v1/app/registration');
    expect((postForm.mock.calls[0]?.[1] as URLSearchParams).toString()).toBe('action=init');
    expect((postForm.mock.calls[1]?.[1] as URLSearchParams).toString()).toBe(
      'action=begin&archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id',
    );
    expect((postForm.mock.calls[3]?.[1] as URLSearchParams).toString()).toBe(
      'action=poll&device_code=device_code_test&tp=ob_app',
    );
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(renderQr).toHaveBeenCalledWith('https://accounts.feishu.cn/verify?code=abc&from=metaclaw&tp=metaclaw');
    expect(postJson).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: 'cli_test', app_secret: 'secret_test' },
    );
    expect(getJson).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bot/v3/info',
      { authorization: 'Bearer tenant_token' },
    );
  });

  it('switches to Lark domain when registration returns lark tenant brand', async () => {
    const postForm = vi.fn()
      .mockResolvedValueOnce({ supported_auth_methods: ['client_secret'] })
      .mockResolvedValueOnce({
        device_code: 'device_code_test',
        verification_uri_complete: 'https://accounts.feishu.cn/verify',
        interval: 1,
        expire_in: 600,
      })
      .mockResolvedValueOnce({
        client_id: 'cli_lark',
        client_secret: 'secret_lark',
        user_info: {
          open_id: 'ou_lark',
          tenant_brand: 'lark',
        },
      });
    const postJson = vi.fn().mockResolvedValue({ code: 0, tenant_access_token: 'tenant_lark' });
    const getJson = vi.fn().mockResolvedValue({ code: 0, bot: { app_name: 'Lark Bot', open_id: 'ou_bot_lark' } });

    const result = await registerFeishuBotByQr({
      deps: {
        postForm,
        postJson,
        getJson,
        sleep: async () => undefined,
        nowMs: () => 0,
      },
    });

    expect(result?.domain).toBe('lark');
    expect(postJson).toHaveBeenCalledWith(
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: 'cli_lark', app_secret: 'secret_lark' },
    );
    expect(getJson).toHaveBeenCalledWith(
      'https://open.larksuite.com/open-apis/bot/v3/info',
      { authorization: 'Bearer tenant_lark' },
    );
  });

  it('returns null when QR registration is denied', async () => {
    const postForm = vi.fn()
      .mockResolvedValueOnce({ supported_auth_methods: ['client_secret'] })
      .mockResolvedValueOnce({
        device_code: 'device_code_test',
        verification_uri_complete: 'https://accounts.feishu.cn/verify',
        interval: 1,
        expire_in: 600,
      })
      .mockResolvedValueOnce({ error: 'access_denied' });

    await expect(registerFeishuBotByQr({
      deps: {
        postForm,
        sleep: async () => undefined,
        nowMs: () => 0,
      },
    })).resolves.toBeNull();
  });
});
