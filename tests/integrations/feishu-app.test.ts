import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import {
  appendMarkdownPreviewLinks,
  createFeishuMarkdownCard,
  createFeishuMarkdownPostContent,
  createFeishuBridge,
  createFeishuWebSocketEventHandlers,
  extractArtifactPaths,
  extractMarkdownArtifactPaths,
  FeishuAppClient,
  formatFeishuProgressReply,
  formatFeishuStreamingProgressReplies,
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
        msg_type: 'interactive',
        content: JSON.stringify(createFeishuMarkdownCard('### hello from metaclaw')),
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

  it('builds Feishu card markdown with the first h1 promoted to the card header', () => {
    expect(createFeishuMarkdownCard([
      '# 关于启动 OPC 试点的公告',
      '',
      'OPC 不是一个人单打独斗，而是 **一个人对一个业务闭环负责**。',
    ].join('\n'))).toEqual({
      config: {
        wide_screen_mode: true,
      },
      header: {
        template: 'blue',
        title: {
          tag: 'plain_text',
          content: '关于启动 OPC 试点的公告',
        },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: 'OPC 不是一个人单打独斗，而是 **一个人对一个业务闭环负责**。',
          },
        },
      ],
    });
  });

  it('keeps structured Feishu card markdown in one element to avoid card truncation', () => {
    expect(createFeishuMarkdownCard([
      '元聚变作为平台，不能保证每一个 OPC 必然成功，但要用机制保证 **OPC 不是孤军创业，而是在平台确定性中创业**。',
      '',
      '核心做法是：',
      '',
      '1. **给方向**：平台提供明确业务场景、客户需求、产品边界，不让 OPC 从零盲目找机会。',
      '2. **给资源**：提供品牌、客户、数据、算力、AI 工具、交付体系、财务法务等基础设施。',
      '3. **给机制**：用 30 天验证、90 天收入、180 天规模化节奏推进。',
    ].join('\n')).elements).toEqual([
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            '元聚变作为平台，不能保证每一个 OPC 必然成功，但要用机制保证 **OPC 不是孤军创业，而是在平台确定性中创业**。',
            '',
            '核心做法是：',
            '',
            '1. **给方向**：平台提供明确业务场景、客户需求、产品边界，不让 OPC 从零盲目找机会。',
            '2. **给资源**：提供品牌、客户、数据、算力、AI 工具、交付体系、财务法务等基础设施。',
            '3. **给机制**：用 30 天验证、90 天收入、180 天规模化节奏推进。',
          ].join('\n'),
        },
      },
    ]);
  });

  it('normalizes headings in long Markdown outlines without splitting into many card elements', () => {
    const card = createFeishuMarkdownCard([
      '你说得对。如果只是“招募 OPC、提供资源、辅导创业、对接资本”，那和外面的 OPC 孵化平台没有本质区别。',
      '元聚变的方案应该改成：不是做一个 OPC 孵化平台，而是把元聚变自身改造成 AI 时代的 OPC 母体组织。',
      '## 一、定位不同：不是孵化别人，而是重构自己',
      '其他 OPC 平台的逻辑是：',
      '> 我有平台，你来创业，我给你资源。',
      '所以重点不是“孵化”，而是：',
      '- AI 产品经理',
      '- AI 研发助手',
      '### 1. AI 技术底座',
      '由 CTO 牵头，建设统一的 AI 工具链、智能体框架、模型调用、知识库、自动化流程。',
    ].join('\n'));

    expect(card.elements).toHaveLength(1);
    expect(card.elements[0]?.text.content).toBe([
      '你说得对。如果只是“招募 OPC、提供资源、辅导创业、对接资本”，那和外面的 OPC 孵化平台没有本质区别。',
      '元聚变的方案应该改成：不是做一个 OPC 孵化平台，而是把元聚变自身改造成 AI 时代的 OPC 母体组织。',
      '**一、定位不同：不是孵化别人，而是重构自己**',
      '其他 OPC 平台的逻辑是：',
      '> 我有平台，你来创业，我给你资源。',
      '所以重点不是“孵化”，而是：',
      '- AI 产品经理',
      '- AI 研发助手',
      '**1. AI 技术底座**',
      '由 CTO 牵头，建设统一的 AI 工具链、智能体框架、模型调用、知识库、自动化流程。',
    ].join('\n'));
  });

  it('renders GitHub-style Markdown tables as structured Feishu-safe Markdown blocks', () => {
    const card = createFeishuMarkdownCard([
      '下面是对比：',
      '',
      '| 维度 | Metaclaw，也就是我 | DeepSeek-TUI |',
      '|---|---|---|',
      '| 核心定位 | 多任务调度与上下文治理层 | 终端原生 coding agent |',
      '| 强项 | 管任务、管上下文、管历史、管偏好、管执行边界 | 直接在终端读写文件、跑命令、改代码、用 Git |',
      '| 使用场景 | 长任务、跨会话任务、带状态的复杂协作 | 本地开发、代码修改、终端交互 |',
      '',
      '结论：两者定位不同。',
    ].join('\n'));

    expect(card).toEqual({
      schema: '2.0',
      config: {
        wide_screen_mode: true,
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: '下面是对比：',
          },
          {
            tag: 'table',
            page_size: 3,
            row_height: 'low',
            columns: [
              {
                name: 'col_0',
                display_name: '维度',
                data_type: 'text',
                width: 'auto',
              },
              {
                name: 'col_1',
                display_name: 'Metaclaw，也就是我',
                data_type: 'text',
                width: 'auto',
              },
              {
                name: 'col_2',
                display_name: 'DeepSeek-TUI',
                data_type: 'text',
                width: 'auto',
              },
            ],
            rows: [
              {
                col_0: '核心定位',
                col_1: '多任务调度与上下文治理层',
                col_2: '终端原生 coding agent',
              },
              {
                col_0: '强项',
                col_1: '管任务、管上下文、管历史、管偏好、管执行边界',
                col_2: '直接在终端读写文件、跑命令、改代码、用 Git',
              },
              {
                col_0: '使用场景',
                col_1: '长任务、跨会话任务、带状态的复杂协作',
                col_2: '本地开发、代码修改、终端交互',
              },
            ],
          },
          {
            tag: 'markdown',
            content: '结论：两者定位不同。',
          },
        ],
      },
    });
  });

  it('can render Markdown tables as Feishu-safe Markdown fallback blocks', () => {
    const card = createFeishuMarkdownCard([
      '下面是对比：',
      '',
      '| 维度 | Metaclaw，也就是我 | DeepSeek-TUI |',
      '|---|---|---|',
      '| 核心定位 | 多任务调度与上下文治理层 | 终端原生 coding agent |',
      '| 强项 | 管任务、管上下文、管历史、管偏好、管执行边界 | 直接在终端读写文件、跑命令、改代码、用 Git |',
      '',
      '结论：两者定位不同。',
    ].join('\n'), { tableMode: 'markdown' });

    expect(card).toEqual({
      config: {
        wide_screen_mode: true,
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '下面是对比：',
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: [
              '**维度：核心定位**',
              '- **Metaclaw，也就是我**：多任务调度与上下文治理层',
              '- **DeepSeek-TUI**：终端原生 coding agent',
              '',
              '**维度：强项**',
              '- **Metaclaw，也就是我**：管任务、管上下文、管历史、管偏好、管执行边界',
              '- **DeepSeek-TUI**：直接在终端读写文件、跑命令、改代码、用 Git',
            ].join('\n'),
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '结论：两者定位不同。',
          },
        },
      ],
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
    expect(session.submit).toHaveBeenCalledWith('hello metaclaw', { awaitAsyncWork: false });
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

    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(1, 'oc_chat', [
      '**处理步骤**',
      '→ 任务 #task_test 已创建：能收到消息吗?',
      '【提取最近历史记录上下文】',
      '→ 派发给 codex-cli...',
      '【构建执行上下文】',
      '【执行上下文准备完成】',
      '→ 正在执行任务 #task_test...',
      '✓ 任务完成 (12.4s)',
    ].join('\n'));
    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(2, 'oc_chat', '能收到。');
  });

  it('streams core progress cards before the final Feishu answer when session subscription is available', async () => {
    let output = ['before'];
    let listener: ((snapshot: { output: string[] }) => void) | null = null;
    const append = (...lines: string[]) => {
      output = [...output, ...lines];
      listener?.({ output: [...output] });
    };
    const session = {
      getSnapshot: vi.fn(() => ({ output: [...output] })),
      subscribe: vi.fn((next: (snapshot: { output: string[] }) => void) => {
        listener = next;
        next({ output: [...output] });
        return () => {
          listener = null;
        };
      }),
      submit: vi.fn().mockImplementation(async () => {
        append('任务 #task_stream 已创建：流式展示步骤');
        append('【提取最近历史记录上下文】');
        append('→ 派发给 codex-cli...');
        append('【构建执行上下文】');
        append('【执行上下文准备完成】');
        append('→ 正在执行任务 #task_stream...');
        append('+ #task_stream 已启动 codex-cli 执行器');
        append('+ #task_stream 最终答案');
        append('+ #task_stream tokens used');
        append('+ #task_stream 123');
        append('+ #task_stream 最终答案');
        append('✓ 任务完成 (3.2s)');
        return { exitRequested: false };
      }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_stream',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"流式展示步骤"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(1, 'oc_chat', '**处理步骤**\n→ 任务 #task_stream 已创建：流式展示步骤');
    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(2, 'oc_chat', '**处理步骤**\n【提取最近历史记录上下文】');
    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(3, 'oc_chat', '**处理步骤**\n→ 派发给 codex-cli...');
    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(4, 'oc_chat', '**处理步骤**\n【构建执行上下文】');
    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(5, 'oc_chat', '**处理步骤**\n【执行上下文准备完成】');
    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(6, 'oc_chat', '**处理步骤**\n→ 正在执行任务 #task_stream...');
    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(7, 'oc_chat', '**处理步骤**\n✓ 任务完成 (3.2s)');
    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(8, 'oc_chat', '最终答案');
    expect(session.subscribe).toHaveBeenCalled();
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

    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(1, 'oc_chat', [
      '**处理步骤**',
      '【提取最近历史记录上下文】',
      '【构建执行上下文】',
      '【执行上下文准备完成】',
    ].join('\n'));
    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(2, 'oc_chat', [
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

    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(1, 'oc_chat', [
      '**处理步骤**',
      '→ 任务 #task_full 已创建：请详细解释一下这个问题',
      '→ 正在执行任务 #task_full...',
      '✓ 任务完成 (12.4s)',
    ].join('\n'));
    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(2, 'oc_chat', fullAnswer);
  });

  it('extracts the urgent task final answer before auto-resumed task progress in Feishu replies', () => {
    const urgentAnswer = [
      '紧急任务最终结果正文',
      '',
      '这里是紧急任务的完整结论，飞书最终回复必须展示这一段。',
    ].join('\n');
    const reply = formatFeishuReply([
      '→ 高优任务到达，抢占当前任务 #task_old',
      '→ 原因：用户插入紧急任务',
      '→ 任务 #task_old 已挂起，开始执行 #task_urgent',
      '→ 派发给 codex-cli...',
      '→ 正在执行任务 #task_urgent...',
      '+ #task_urgent 已启动 codex-cli 执行器',
      ...urgentAnswer.split('\n'),
      '+ #task_urgent tokens used',
      '+ #task_urgent 1,234',
      '✓ 任务完成 (17.2s)',
      '┌─ 任务结果 ───────────────────────────────────────┐',
      '│ 摘要: 紧急任务最终结果正文',
      '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
      '└──────────────────────────────────────────────────┘',
      '→ 正在执行任务 #task_old...',
      '+ #task_old 已启动 codex-cli 执行器',
    ]);

    expect(reply).toBe(urgentAnswer);
    expect(reply).not.toContain('→ 正在执行任务 #task_old...');
  });

  it('extracts a resumed task final answer once and preserves the full markdown body', () => {
    const resumedAnswer = [
      '恢复后的调研结论如下：AI agent 的未来不是“一个万能助手”，而是“可治理、可编排、可审计、可交易的数字劳动力网络”。',
      '# AI Agent 未来发展趋势深度调研',
      '一、总判断',
      'AI agent 正在从三个阶段演进：',
      '1. 聊天助手阶段',
      '代表：ChatGPT、Claude、Copilot。',
      '特点是回答、总结、写作、辅助决策。',
      '2. **工具执行阶段**',
      '代表：Manus、Devin、Claude Code、Codex。',
      '特点是可调用工具、读写文件、执行复杂任务。',
    ].join('\n');
    const reply = formatFeishuReply([
      '→ 正在执行任务 #task_old...',
      '+ #task_old 已启动 codex-cli 执行器',
      ...resumedAnswer.split('\n'),
      'tokens used',
      '2,468',
      ...resumedAnswer.split('\n'),
      '✓ 任务完成 (18.4s)',
      '┌─ 任务结果 ───────────────────────────────────────┐',
      '│ 摘要: 恢复后的调研结论如下：AI agent 的未来不是“一个万能助手”，而是“可治理、可编排、可审计、可交易的数字劳动力网络”。',
      '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
      '└──────────────────────────────────────────────────┘',
    ]);

    expect(reply).toBe(resumedAnswer);
    expect(reply?.match(/恢复后的调研结论如下/g)).toHaveLength(1);
    expect(reply).toContain('2. **工具执行阶段**');
    expect(reply).toContain('特点是可调用工具、读写文件、执行复杂任务。');
  });

  it('appends Markdown preview links for generated task artifacts', () => {
    const outputLines = [
      '✓ 任务完成 (3.1s)',
      '→ 已记录 2 个任务产物',
      '   - /repo/metaclaw-tasks/task_doc/report.md',
      '   - /repo/metaclaw-tasks/task_doc/data.json',
    ];

    expect(extractMarkdownArtifactPaths(outputLines)).toEqual([
      '/repo/metaclaw-tasks/task_doc/report.md',
    ]);
    expect(extractArtifactPaths(outputLines)).toEqual([
      '/repo/metaclaw-tasks/task_doc/report.md',
      '/repo/metaclaw-tasks/task_doc/data.json',
    ]);
    expect(appendMarkdownPreviewLinks('文档已生成。', outputLines, {
      baseUrl: 'https://preview.example.com',
      workspaceRoot: '/repo',
    })).toBe([
      '文档已生成。',
      '',
      '**Markdown 在线预览**',
      '- [report.md](https://preview.example.com/preview/metaclaw-tasks%2Ftask_doc%2Freport.md)',
    ].join('\n'));
  });

  it('includes Markdown preview links in the final Feishu answer when task artifacts are Markdown files', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 生成一份 Markdown 文档',
            '任务 #task_doc 已创建：生成一份 Markdown 文档',
            '→ 正在执行任务 #task_doc...',
            '+ #task_doc 已启动 codex-cli 执行器',
            '+ #task_doc 文档已生成。',
            '+ #task_doc tokens used',
            '+ #task_doc 123',
            '✓ 任务完成 (3.1s)',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: 文档已生成。',
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
            '→ 文件输出目录: /repo/metaclaw-tasks/task_doc',
            '→ 已省略文件正文输出，请直接查看生成文件',
            '→ 已记录 1 个任务产物',
            '   - /repo/metaclaw-tasks/task_doc/report.md',
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
        message_id: 'om_message_doc',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"生成一份 Markdown 文档"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
      markdownPreview: {
        baseUrl: 'https://preview.example.com',
        workspaceRoot: '/repo',
      },
    });

    const finalReply = client.sendMarkdownCardToChat.mock.calls.at(-1)?.[1];
    expect(finalReply).toContain('文档已生成。');
    expect(finalReply).toContain('**Markdown 在线预览**');
    expect(finalReply).toContain('[report.md](https://preview.example.com/preview/metaclaw-tasks%2Ftask_doc%2Freport.md)');
  });

  it('uploads every generated artifact file back to Feishu as browsable file messages', async () => {
    const repoDir = mkdtempSync(resolve(tmpdir(), 'metaclaw-feishu-artifacts-'));
    const taskDir = resolve(repoDir, 'metaclaw-tasks', 'task_doc');
    mkdirSync(taskDir, { recursive: true });
    const reportPath = resolve(taskDir, 'report.md');
    const sheetPath = resolve(taskDir, 'data.csv');
    writeFileSync(reportPath, '# Report\n正文', 'utf-8');
    writeFileSync(sheetPath, 'a,b\n1,2\n', 'utf-8');

    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 生成文件',
            '任务 #task_doc 已创建：生成文件',
            '+ #task_doc 已启动 codex-cli 执行器',
            '+ #task_doc 文件已生成。',
            '+ #task_doc tokens used',
            '+ #task_doc 123',
            '✓ 任务完成 (3.1s)',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: 文件已生成。',
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
            `→ 文件输出目录: ${taskDir}`,
            '→ 已省略文件正文输出，请直接查看生成文件',
            '→ 已记录 2 个任务产物',
            `   - ${reportPath}`,
            `   - ${sheetPath}`,
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
      uploadFile: vi.fn()
        .mockResolvedValueOnce('file_key_report')
        .mockResolvedValueOnce('file_key_sheet'),
      sendFileToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_files',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"生成文件"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
      markdownPreview: {
        baseUrl: 'https://preview.example.com',
        workspaceRoot: repoDir,
      },
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', [
      '**任务产物已同步到飞书**',
      '- report.md',
      '- data.csv',
    ].join('\n'));
    expect(client.uploadFile).toHaveBeenNthCalledWith(1, reportPath);
    expect(client.uploadFile).toHaveBeenNthCalledWith(2, sheetPath);
    expect(client.sendFileToChat).toHaveBeenNthCalledWith(1, 'oc_chat', 'file_key_report');
    expect(client.sendFileToChat).toHaveBeenNthCalledWith(2, 'oc_chat', 'file_key_sheet');
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
    expect(sentTexts[0]).toBe([
      '**处理步骤**',
      '→ 任务 #task_long 已创建：请完整输出长内容',
      '✓ 任务完成 (12.4s)',
    ].join('\n'));
    expect(sentTexts.slice(1).join('')).toBe(longAnswer);
    expect(sentTexts.every(text => text.length <= 3500)).toBe(true);
    expect(sentTexts.join('')).not.toContain('[已截断]');
  });

  it('keeps Feishu replies scoped to the submitted task across urgent preemption and resume', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 紧急优先处理客户问题',
            '任务 #task_urgent 已创建：紧急优先处理客户问题',
            '→ 抢占当前任务 #task_main',
            '→ 正在执行任务 #task_urgent...',
            '+ #task_urgent 已启动 codex-cli 执行器',
            '+ #task_urgent urgent raw should be ignored because appended result is complete',
            '✓ 任务完成 (0.4s)',
            '',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: urgent summary only',
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
            '',
            'urgent full line 1',
            'urgent full line 2',
            '→ 正在执行任务 #task_main...',
            '+ #task_main 已启动 codex-cli 执行器',
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
        message_id: 'om_message_urgent',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"紧急优先处理客户问题"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    expect(sentTexts.join('\n')).toContain('urgent full line 1\nurgent full line 2');
    expect(sentTexts.join('\n')).not.toContain('urgent summary only');
    expect(sentTexts.join('\n')).not.toContain('task_main');
  });

  it('replies as soon as the urgent Feishu task completes without waiting for resumed original output', async () => {
    let listener: ((snapshot: { output: string[] }) => void) | undefined;
    const output = ['before'];
    let resolveSubmit!: () => void;
    const submitPromise = new Promise<{ exitRequested: false }>(resolve => {
      resolveSubmit = () => resolve({ exitRequested: false });
    });
    const session = {
      getSnapshot: vi.fn(() => ({ output: [...output] })),
      subscribe: vi.fn((callback: (snapshot: { output: string[] }) => void) => {
        listener = callback;
        callback({ output: [...output] });
        return vi.fn();
      }),
      submit: vi.fn().mockImplementation(() => submitPromise),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    const handled = handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_urgent_async',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"紧急优先处理客户问题"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    await Promise.resolve();
    output.push(
      '> 紧急优先处理客户问题',
      '任务 #task_urgent 已创建：紧急优先处理客户问题',
      '→ 抢占当前任务 #task_main',
      '→ 正在执行任务 #task_urgent...',
      '✓ 任务完成 (0.4s)',
      '',
      '┌─ 任务结果 ───────────────────────────────────────┐',
      '│ 摘要: urgent summary only',
      '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
      '└──────────────────────────────────────────────────┘',
      '',
      'urgent full line 1',
      'urgent full line 2',
      '→ 正在执行任务 #task_main...',
    );
    listener?.({ output: [...output] });
    resolveSubmit();
    await handled;

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    expect(sentTexts.join('\n')).toContain('urgent full line 1\nurgent full line 2');
    expect(sentTexts.join('\n')).not.toContain('urgent summary only');
    expect(sentTexts.join('\n')).not.toContain('task_main');

    output.push('main result should arrive too late for urgent reply');
    listener?.({ output: [...output] });
    expect(client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text).join('\n'))
      .not.toContain('main result should arrive too late');
  });

  it('streams resumed task guidance to Feishu after an urgent task completes', async () => {
    const listeners = new Set<(snapshot: { output: string[] }) => void>();
    const output = ['before'];
    const notify = () => {
      for (const listener of listeners) {
        listener({ output: [...output] });
      }
    };
    let resolveSubmit!: () => void;
    const submitPromise = new Promise<{ exitRequested: false }>(resolve => {
      resolveSubmit = () => resolve({ exitRequested: false });
    });
    const session = {
      getSnapshot: vi.fn(() => ({ output: [...output] })),
      subscribe: vi.fn((callback: (snapshot: { output: string[] }) => void) => {
        listeners.add(callback);
        callback({ output: [...output] });
        return () => {
          listeners.delete(callback);
        };
      }),
      submit: vi.fn().mockImplementation(() => submitPromise),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    const handled = handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_urgent_resume_guidance',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"紧急优先处理客户问题"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    await Promise.resolve();
    output.push(
      '> 紧急优先处理客户问题',
      '任务 #task_urgent 已创建：紧急优先处理客户问题',
      '→ 抢占当前任务 #task_main',
      '→ 正在执行任务 #task_urgent...',
      '✓ 任务完成 (0.4s)',
      '',
      '┌─ 任务结果 ───────────────────────────────────────┐',
      '│ 摘要: urgent summary only',
      '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
      '└──────────────────────────────────────────────────┘',
      '',
      'urgent full line 1',
      'urgent full line 2',
      '┌─ 操作指引 ───────────────────────────────────────┐',
      '│ 场景：恢复已挂起任务',
      '│ 推荐动作：继续处理任务 #task_main: 之前的长任务',
      '│ 目标任务：#task_main 之前的长任务',
      '│ 原因：刚被高优任务打断，恢复连续性收益最高',
      '│       下一步已明确：恢复后继续当前未完成步骤',
      '└──────────────────────────────────────────────────┘',
      '→ 正在执行任务 #task_main...',
      '+ #task_main old task output must not leak into urgent reply',
    );
    notify();
    resolveSubmit();
    await handled;

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    const allSent = sentTexts.join('\n');
    expect(allSent).toContain('urgent full line 1\nurgent full line 2');
    expect(sentTexts).toContain([
      '**恢复已挂起任务**',
      '→ 继续处理任务 #task_main: 之前的长任务',
      '任务：#task_main 之前的长任务',
      '- 刚被高优任务打断，恢复连续性收益最高',
      '- 下一步已明确：恢复后继续当前未完成步骤',
    ].join('\n'));
    expect(allSent).not.toContain('urgent summary only');
    expect(allSent).not.toContain('old task output must not leak');
  });

  it('keeps resumed Feishu replies scoped to the resumed task instead of the later latest task', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 继续刚才主线任务',
            '→ 命中上次任务指针 #task_main',
            '→ 正在执行任务 #task_main...',
            '+ #task_main 已启动 codex-cli 执行器',
            '✓ 任务完成 (0.8s)',
            '',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: main summary only',
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
            '',
            'main full line 1',
            'main full line 2',
            '任务 #task_later 已创建：后续排队任务',
            '→ 正在执行任务 #task_later...',
            '+ #task_later 已启动 codex-cli 执行器',
            '+ #task_later later output must not leak',
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
        message_id: 'om_message_resume',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"继续刚才主线任务"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    expect(sentTexts.join('\n')).toContain('main full line 1\nmain full line 2');
    expect(sentTexts.join('\n')).not.toContain('main summary only');
    expect(sentTexts.join('\n')).not.toContain('later output must not leak');
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
    expect(session.submit).toHaveBeenCalledWith('hello metaclaw', { awaitAsyncWork: false });
    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', 'metaclaw reply');
    expect(client.removeReactionFromMessage).not.toHaveBeenCalled();
  });

  it('does not send a fallback reply when Metaclaw has no user-facing output yet', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 帮我分析 OPC 方案',
            '任务 #task_empty 已创建：帮我分析 OPC 方案',
            '→ 派发给 codex-cli...',
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
        message_id: 'om_message_empty',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"帮我分析 OPC 方案"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.sendMarkdownCardToChat).not.toHaveBeenCalled();
    expect(client.removeReactionFromMessage).toHaveBeenCalledWith('om_message_empty', 'reaction_typing');
  });

  it('replies with an explicit pending message when the task is queued', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 帮我分析 OPC 方案',
            '任务 #task_queued 已创建：帮我分析 OPC 方案',
            '→ 任务 #task_queued 已进入待执行队列',
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
        message_id: 'om_message_queued',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"帮我分析 OPC 方案"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith(
      'oc_chat',
      '任务 #task_queued 已进入待执行队列，等待当前任务完成后会继续执行。',
    );
    expect(client.sendMarkdownCardToChat).not.toHaveBeenCalledWith('oc_chat', '已处理。');
  });

  it('can format plain conversation output without task result framing', () => {
    expect(formatFeishuReply(['> 你好', '你好，我在。'])).toBe('你好，我在。');
  });

  it('formats core progress steps separately from the final Feishu answer', () => {
    expect(formatFeishuProgressReply([
      '> 今天早上都执行了什么任务',
      '任务 #task_OO0EG38SJo 已创建：今天早上都执行了什么任务',
      '【提取最近历史记录上下文】',
      '→ 派发给 codex-cli...',
      '【构建执行上下文】',
      '【执行上下文准备完成】',
      '→ 正在执行任务 #task_OO0EG38SJo...',
      '✓ 任务完成 (8.1s)',
      '最终答案',
    ])).toBe([
      '**处理步骤**',
      '→ 任务 #task_OO0EG38SJo 已创建：今天早上都执行了什么任务',
      '【提取最近历史记录上下文】',
      '→ 派发给 codex-cli...',
      '【构建执行上下文】',
      '【执行上下文准备完成】',
      '→ 正在执行任务 #task_OO0EG38SJo...',
      '✓ 任务完成 (8.1s)',
    ].join('\n'));
  });

  it('formats streaming progress replies as one card per newly observed step', () => {
    const sent = new Set<string>();
    expect(formatFeishuStreamingProgressReplies([
      '任务 #task_stream 已创建：测试',
      '任务 #task_stream 已创建：测试',
      '【提取最近历史记录上下文】',
    ], sent)).toEqual([
      '**处理步骤**\n→ 任务 #task_stream 已创建：测试',
      '**处理步骤**\n【提取最近历史记录上下文】',
    ]);
    expect(formatFeishuStreamingProgressReplies([
      '【提取最近历史记录上下文】',
      '→ 派发给 codex-cli...',
    ], sent)).toEqual([
      '**处理步骤**\n→ 派发给 codex-cli...',
    ]);
  });

  it('streams resumed task guidance blocks to Feishu before the final result', () => {
    const sent = new Set<string>();
    const replies = formatFeishuStreamingProgressReplies([
      '┌─ 操作指引 ───────────────────────────────────────┐',
      '│ 场景：恢复已挂起任务',
      '│ 推荐动作：继续处理任务 #task_main: DeepSeek 最近更新汇总',
      '│ 目标任务：#task_main DeepSeek 最近更新汇总',
      '│ 原因：刚被高优任务打断，恢复连续性收益最高',
      '│       下一步已明确：恢复后继续当前未完成步骤',
      '└──────────────────────────────────────────────────┘',
      '【提取最近历史记录上下文】',
    ], sent);

    expect(replies[0]).toBe([
      '**恢复已挂起任务**',
      '→ 继续处理任务 #task_main: DeepSeek 最近更新汇总',
      '任务：#task_main DeepSeek 最近更新汇总',
      '- 刚被高优任务打断，恢复连续性收益最高',
      '- 下一步已明确：恢复后继续当前未完成步骤',
    ].join('\n'));
    expect(replies[1]).toBe('**处理步骤**\n【提取最近历史记录上下文】');
  });
});
