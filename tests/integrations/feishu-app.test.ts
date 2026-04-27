import { describe, expect, it, vi } from 'vitest';
import {
  createFeishuMarkdownPostContent,
  createFeishuBridge,
  createFeishuWebSocketEventHandlers,
  FeishuAppClient,
  formatFeishuReply,
  handleFeishuMessageEvent,
  parseFeishuTextContent,
  resolveAppSecret,
} from '../../src/integrations/feishu-app.js';

describe('FeishuAppClient', () => {
  it('fetches tenant access token, sends Markdown cards, and manages reactions', async () => {
    const postJson = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }),
        text: async () => 'ok',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0 }),
        text: async () => 'ok',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { reaction_id: 'reaction_typing' } }),
        text: async () => 'ok',
      });
    const deleteJson = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0 }),
      text: async () => 'ok',
    });
    const client = new FeishuAppClient({ app_id: 'cli_test', app_secret: 'secret' }, { postJson, deleteJson });

    await client.sendMarkdownCardToChat('oc_chat', '### hello from metaclaw');
    await expect(client.addReactionToMessage('om_message', 'Typing')).resolves.toBe('reaction_typing');
    await client.removeReactionFromMessage('om_message', 'reaction_typing');

    expect(postJson).toHaveBeenNthCalledWith(
      1,
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: 'cli_test', app_secret: 'secret' },
    );
    expect(postJson).toHaveBeenNthCalledWith(
      2,
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        receive_id: 'oc_chat',
        msg_type: 'post',
        content: JSON.stringify(createFeishuMarkdownPostContent('### hello from metaclaw')),
      },
      { authorization: 'Bearer tenant-token' },
    );
    expect(postJson).toHaveBeenNthCalledWith(
      3,
      'https://open.feishu.cn/open-apis/im/v1/messages/om_message/reactions',
      {
        reaction_type: {
          emoji_type: 'Typing',
        },
      },
      { authorization: 'Bearer tenant-token' },
    );
    expect(deleteJson).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/im/v1/messages/om_message/reactions/reaction_typing',
      { authorization: 'Bearer tenant-token' },
    );
  });
});

describe('Feishu app helpers', () => {
  it('parses text message content payloads', () => {
    expect(parseFeishuTextContent('{"text":"hi metaclaw"}')).toBe('hi metaclaw');
  });

  it('builds Feishu post markdown content with isolated fenced code blocks', () => {
    expect(createFeishuMarkdownPostContent([
      '说明',
      '```ts',
      'const ok = true;',
      '```',
      '结论',
    ].join('\n'))).toEqual({
      zh_cn: {
        content: [
          [{ tag: 'md', text: '说明' }],
          [{ tag: 'md', text: '```ts\nconst ok = true;\n```' }],
          [{ tag: 'md', text: '结论' }],
        ],
      },
    });
  });

  it('resolves app secret from env when configured', () => {
    process.env.TEST_FEISHU_SECRET = 'from-env';
    expect(resolveAppSecret({
      enabled: true,
      app_id: 'cli_test',
      app_secret_env: 'TEST_FEISHU_SECRET',
      event_port: 8787,
      event_path: '/feishu/events',
    })).toBe('from-env');
  });

  it('reports the missing app secret env var name when Feishu bridge is enabled', () => {
    const previousSecret = process.env.TEST_FEISHU_MISSING_SECRET;
    delete process.env.TEST_FEISHU_MISSING_SECRET;

    expect(() => createFeishuBridge({
      version: 1,
      executor: {
        command: 'codex',
        timeout: 300,
        max_duration: 3600,
      },
      integrations: {
        feishu: {
          enabled: true,
          app_id: 'cli_test',
          app_secret_env: 'TEST_FEISHU_MISSING_SECRET',
        },
      },
    }, {} as never)).toThrow('环境变量 TEST_FEISHU_MISSING_SECRET 未设置');

    if (previousSecret === undefined) {
      delete process.env.TEST_FEISHU_MISSING_SECRET;
    } else {
      process.env.TEST_FEISHU_MISSING_SECRET = previousSecret;
    }
  });

  it('registers no-op event handlers to avoid SDK missing-handler warnings', async () => {
    const session = {
      getSnapshot: vi.fn().mockReturnValue({ output: [] }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };
    const handlers = createFeishuWebSocketEventHandlers({
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(handlers['im.message.message_read_v1']).toBeTypeOf('function');
    expect(handlers['im.message.reaction.created_v1']).toBeTypeOf('function');
    expect(handlers['im.message.reaction.deleted_v1']).toBeTypeOf('function');
    expect(handlers['im.message.message_read_v1']?.({})).toBeUndefined();
    expect(handlers['im.message.reaction.created_v1']?.({})).toBeUndefined();
    expect(handlers['im.message.reaction.deleted_v1']?.({})).toBeUndefined();
    expect(session.submit).not.toHaveBeenCalled();
  });

  it('submits websocket message events to Metaclaw and replies to the source chat', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({ output: ['before', 'metaclaw reply'] }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"hello metaclaw"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.addReactionToMessage).toHaveBeenCalledWith('om_message', 'Typing');
    expect(session.submit).toHaveBeenCalledWith('hello metaclaw', { awaitAsyncWork: true });
    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', 'metaclaw reply');
    expect(client.removeReactionFromMessage).toHaveBeenCalledWith('om_message', 'reaction_typing');
    expect(client.addReactionToMessage.mock.invocationCallOrder[0]).toBeLessThan(
      session.submit.mock.invocationCallOrder[0],
    );
    expect(client.removeReactionFromMessage.mock.invocationCallOrder[0]).toBeGreaterThan(
      client.sendMarkdownCardToChat.mock.invocationCallOrder[0],
    );
  });

  it('replies with the final task answer instead of Metaclaw execution logs', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 能收到消息吗?',
            '任务 #task_test 已创建：能收到消息吗?',
            '[提取最近历史记录上下文]',
            '→ 派发给 codex-cli...',
            '[构建执行上下文]',
            '[执行上下文准备完成]',
            '→ 正在执行任务 #task_test...',
            '+ #task_test 已启动 codex-cli 执行器',
            '+ #task_test 关联历史：',
            '+ #task_test [普通对话] 用户: 听到了吗?',
            '+ #task_test [助手: 听到了。有什么要我处理?',
            '+ #task_test codex',
            '+ #task_test 能收到。',
            '+ #task_test tokens used',
            '+ #task_test 670',
            '+ #task_test 能收到。',
            '✓ 任务完成 (12.4s)',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: 能收到。',
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"能收到消息吗?"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', '能收到。');
  });

  it('replies with a multiline task summary and strips execution history logs', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '【提取最近历史记录上下文】',
            '【构建执行上下文】',
            '【执行上下文准备完成】',
            '· #task_VgmCT6a9Ti 已启动 codex-cli 执行器',
            '· #task_VgmCT6a9Ti 关联历史：',
            '· #task_VgmCT6a9Ti [任务#task_qiG5ghS6LV] 用户: zarazhang这个博主帮我调研下',
            '· #task_VgmCT6a9Ti 助手: 以下是基于公开资料的调研结论。',
            '· #task_VgmCT6a9Ti tokens used',
            '· #task_VgmCT6a9Ti 1,195',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: 我刚才根据注入的历史上下文，回答了你“之前都做过什么任务”的问题，概括了几件事：',
            '',
            '1. 调研 Zara Zhang / 张咋啦。',
            '2. 把长篇调研结果保存为本地 Markdown 文件。',
            '3. 说明保存路径和文件内容限制。',
            '4. 总结这些都是基于当前上下文能看到的历史，不额外访问本地文件。',
            '│ 下一步: 如需延续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"你之前都做过什么任务啊？"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', [
      '我刚才根据注入的历史上下文，回答了你“之前都做过什么任务”的问题，概括了几件事：',
      '',
      '1. 调研 Zara Zhang / 张咋啦。',
      '2. 把长篇调研结果保存为本地 Markdown 文件。',
      '3. 说明保存路径和文件内容限制。',
      '4. 总结这些都是基于当前上下文能看到的历史，不额外访问本地文件。',
    ].join('\n'));
  });

  it('replies with the full executor answer instead of the task summary for Feishu only', async () => {
    const fullAnswer = [
      '第一段：这是执行器生成的完整回答开头。',
      '',
      '第二段：这里包含超过任务摘要的正文内容，飞书应该收到这些内容。',
      '第三段：这行也必须保留，证明没有只取 200 字摘要。',
    ].join('\n');
    const truncatedSummary = `${fullAnswer.slice(0, 30)}...被摘要截断`;
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 请详细解释一下这个问题',
            '任务 #task_full 已创建：请详细解释一下这个问题',
            '→ 正在执行任务 #task_full...',
            '+ #task_full 已启动 codex-cli 执行器',
            ...fullAnswer.split('\n').map(line => `+ #task_full ${line}`),
            '+ #task_full tokens used',
            '+ #task_full 1,234',
            '✓ 任务完成 (12.4s)',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            `│ 摘要: ${truncatedSummary}`,
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_full',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"请详细解释一下这个问题"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', fullAnswer);
  });

  it('sends long Feishu replies in multiple ordered messages without dropping content', async () => {
    const longAnswer = [
      `${'甲'.repeat(1800)}`,
      `${'乙'.repeat(1800)}`,
      `${'丙'.repeat(900)}`,
    ].join('\n');
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 请完整输出长内容',
            '任务 #task_long 已创建：请完整输出长内容',
            '+ #task_long 已启动 codex-cli 执行器',
            ...longAnswer.split('\n').map(line => `+ #task_long ${line}`),
            '+ #task_long tokens used',
            '+ #task_long 1,234',
            '✓ 任务完成 (12.4s)',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            `│ 摘要: ${longAnswer.slice(0, 30)}...`,
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_long',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"请完整输出长内容"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    expect(sentTexts.join('')).toBe(longAnswer);
    expect(sentTexts.every(text => text.length <= 3500)).toBe(true);
    expect(sentTexts.join('')).not.toContain('[已截断]');
  });

  it('continues processing when the typing reaction cannot be added', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({ output: ['before', 'metaclaw reply'] }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockRejectedValue(new Error('missing reaction permission')),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"hello metaclaw"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(session.appendSystemMessage).toHaveBeenCalledWith('⚠️ 飞书 Typing 表情添加失败: missing reaction permission');
    expect(session.submit).toHaveBeenCalledWith('hello metaclaw', { awaitAsyncWork: true });
    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', 'metaclaw reply');
    expect(client.removeReactionFromMessage).not.toHaveBeenCalled();
  });

  it('can format plain conversation output without task result framing', () => {
    expect(formatFeishuReply(['> 你好', '你好，我在。'])).toBe('你好，我在。');
  });
});
