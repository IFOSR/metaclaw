import { describe, it, expect, vi } from 'vitest';
import { LlmBridge } from '../../src/core/llm-bridge.js';

describe('LlmBridge', () => {
  describe('resolveIntent', () => {
    it('应构造包含任务列表的 prompt', () => {
      const bridge = new LlmBridge('claude');
      const prompt = (bridge as any).buildIntentPrompt('之前帮我比较的那两个开源项目', [
        { id: 'task_1', title: 'hermes vs openclaw 调研', goal: '对比分析', summary: '已完成对比', status: 'done' },
        { id: 'task_2', title: '周报整理', goal: '整理本周工作', summary: '', status: 'parked' },
      ]);
      expect(prompt).toContain('之前帮我比较的那两个开源项目');
      expect(prompt).toContain('task_1');
      expect(prompt).toContain('hermes vs openclaw');
      expect(prompt).toContain('task_2');
      expect(prompt).toContain('[done]');
      expect(prompt).toContain('[parked]');
    });

    it('显式恢复挂起任务时会对 parked 任务做二次判定', async () => {
      const bridge = new LlmBridge('claude');
      const querySpy = vi.spyOn(bridge, 'query')
        .mockResolvedValueOnce('{"type":"new","taskId":null,"reason":"首轮未识别"}')
        .mockResolvedValueOnce('{"type":"reference","taskId":"task_parked","reason":"命中挂起任务"}');

      const result = await bridge.resolveIntent('继续之前挂起的任务', [
        {
          id: 'task_done',
          title: '比亚迪 vs 宁德时代',
          goal: '新能源电池份额调研',
          summary: '宁德时代份额更高',
          status: 'done',
        },
        {
          id: 'task_parked',
          title: 'agent memory 开源调研',
          goal: '调研 memory 方案',
          summary: '已整理主流方向',
          status: 'parked',
        },
      ]);

      expect(querySpy).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        type: 'reference',
        taskId: 'task_parked',
        reason: '命中挂起任务',
      });
    });

    it('解析 reference 类型的 JSON 返回', () => {
      const bridge = new LlmBridge('claude');
      const result = (bridge as any).parseIntentResult(
        '```json\n{"type":"reference","taskId":"task_1","reason":"用户提到比较开源项目"}\n```'
      );
      expect(result.type).toBe('reference');
      expect(result.taskId).toBe('task_1');
    });

    it('解析 new 类型的 JSON 返回', () => {
      const bridge = new LlmBridge('claude');
      const result = (bridge as any).parseIntentResult(
        '{"type":"new","taskId":null,"reason":"全新请求"}'
      );
      expect(result.type).toBe('new');
      expect(result.taskId).toBeNull();
    });

    it('JSON 解析失败时 fallback 为 new', () => {
      const bridge = new LlmBridge('claude');
      const result = (bridge as any).parseIntentResult('这不是 JSON');
      expect(result.type).toBe('new');
      expect(result.taskId).toBeNull();
    });

    it('无任务列表时直接返回 new，不调用 LLM', async () => {
      const bridge = new LlmBridge('claude');
      const querySpy = vi.spyOn(bridge as any, 'query');
      const result = await bridge.resolveIntent('你好', []);
      expect(result.type).toBe('new');
      expect(querySpy).not.toHaveBeenCalled();
    });
  });

  describe('resolveRoute', () => {
    it('builds a routing prompt with task overview', () => {
      const bridge = new LlmBridge('claude');
      const prompt = (bridge as any).buildRoutePrompt('hi', [
        { id: 'task_1', title: '行业调研', goal: '输出结论', summary: '进行中', status: 'running' },
      ]);

      expect(prompt).toContain('conversation');
      expect(prompt).toContain('task_control');
      expect(prompt).toContain('durable_task');
      expect(prompt).toContain('[running] 行业调研');
    });

    it('parses route result json', () => {
      const bridge = new LlmBridge('claude');
      const result = (bridge as any).parseRouteResult('{"route":"conversation","reason":"普通问候"}');

      expect(result).toMatchObject({
        route: 'conversation',
        reason: '普通问候',
      });
    });

    it('falls back to unknown when route json is invalid', () => {
      const bridge = new LlmBridge('claude');
      const result = (bridge as any).parseRouteResult('not json');

      expect(result.route).toBe('unknown');
    });
  });

  describe('resolveIntentDecision', () => {
    it('parses full intent decision json for the legacy route-compatible path', () => {
      const bridge = new LlmBridge('claude');
      const result = (bridge as any).parseIntentDecisionResult(JSON.stringify({
        intent: 'executor_dispatch',
        confidence: 0.86,
        needsClarification: false,
        needsLongRunningTask: true,
        requiresLocalRepo: true,
        requiresResearch: false,
        requiresMultiTool: false,
        requiresLongTermMemory: false,
        requiresExternalGateway: false,
        canModifyFiles: true,
        shouldCreateDurableTask: true,
        statusScope: 'running',
        clarificationQuestion: null,
        reason: '需要本地仓库执行',
        route: {
          target: 'codex-cli',
          action: 'auto_dispatch',
          primaryIntent: 'repo_execution',
          capabilityClass: 'repo_execution',
          requiredCapabilities: ['coding', 'tests'],
          matchedBoundary: ['repo_mutation'],
          riskLevel: 'medium',
          taskId: 'task_1',
        },
      }));

      expect(result).toMatchObject({
        intent: 'executor_dispatch',
        confidence: 0.86,
        needsLongRunningTask: true,
        requiresLocalRepo: true,
        statusScope: 'running',
        clarificationQuestion: null,
        route: {
          target: 'codex-cli',
          action: 'auto_dispatch',
          primaryIntent: 'repo_execution',
          capabilityClass: 'repo_execution',
          requiredCapabilities: ['coding', 'tests'],
          matchedBoundary: ['repo_mutation'],
          riskLevel: 'medium',
          taskId: 'task_1',
        },
      });
    });

    it('falls back to clarification when intent decision json is invalid', () => {
      const bridge = new LlmBridge('claude');
      const result = (bridge as any).parseIntentDecisionResult('not json');

      expect(result).toMatchObject({
        intent: 'clarification',
        needsClarification: true,
        confidence: 0,
        route: {
          target: 'metaclaw',
          action: 'ask_clarification',
          primaryIntent: 'conversation_or_control',
        },
      });
    });
  });

  describe('resolveTaskResumeIntent', () => {
    it('builds a semantic resume prompt for blocked and parked tasks only', () => {
      const bridge = new LlmBridge('claude');
      const prompt = (bridge as any).buildTaskResumeIntentPrompt('把之前那个卡住的调研继续跑起来', [
        { id: 'task_blocked', title: '飞书云文档调研', goal: '调研飞书能力', summary: '等待授权', status: 'blocked' },
        { id: 'task_parked', title: 'Pi Agent 调研', goal: '调研 Pi', summary: '等待恢复', status: 'parked' },
      ]);

      expect(prompt).toContain('这是语义判断，不要只看关键词');
      expect(prompt).toContain('action=resume');
      expect(prompt).toContain('task_blocked');
      expect(prompt).toContain('[blocked]');
      expect(prompt).toContain('task_parked');
      expect(prompt).toContain('[parked]');
    });

    it('resolves a semantic resume decision against valid candidates', async () => {
      const bridge = new LlmBridge('claude');
      const querySpy = vi.spyOn(bridge, 'query')
        .mockResolvedValue('{"action":"resume","taskId":"task_parked","confidence":0.91,"reason":"用户要求恢复旧调研任务"}');

      const result = await bridge.resolveTaskResumeIntent('继续之前那个调研', [
        { id: 'task_parked', title: 'Pi Agent 调研', goal: '调研 Pi', summary: '等待恢复', status: 'parked' },
        { id: 'task_done', title: '已完成任务', goal: '完成', summary: '', status: 'done' },
      ]);

      expect(querySpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        action: 'resume',
        taskId: 'task_parked',
        confidence: 0.91,
        reason: '用户要求恢复旧调研任务',
      });
    });

    it('falls back to none when no parked or blocked candidates exist', async () => {
      const bridge = new LlmBridge('claude');
      const querySpy = vi.spyOn(bridge, 'query');

      const result = await bridge.resolveTaskResumeIntent('继续之前那个任务', [
        { id: 'task_done', title: '已完成任务', goal: '完成', summary: '', status: 'done' },
      ]);

      expect(result.action).toBe('none');
      expect(querySpy).not.toHaveBeenCalled();
    });
  });

  describe('resolveTaskPriority', () => {
    it('asks for semantic priority instead of keyword-only matching', () => {
      const bridge = new LlmBridge('claude');
      const prompt = (bridge as any).buildTaskPriorityPrompt('这个客户今晚要看，先处理一下 harness 对比');

      expect(prompt).toContain('必须做语义判断，不要只看关键词');
      expect(prompt).toContain('插队');
      expect(prompt).toContain('顺序执行即可');
    });

    it('parses semantic priority json', () => {
      const bridge = new LlmBridge('claude');
      const result = (bridge as any).parseTaskPriorityResult(
        '{"priority":"urgent","reason":"用户语义上要求先处理临时任务"}'
      );

      expect(result).toEqual({
        priority: 'urgent',
        reason: '用户语义上要求先处理临时任务',
      });
    });
  });

  describe('rankInteractions', () => {
    it('应构造包含候选列表的 prompt', () => {
      const bridge = new LlmBridge('claude');
      const prompt = (bridge as any).buildRankPrompt('之前的调研', [
        { id: 'int_1', userInput: 'hermes vs openclaw 调研' },
        { id: 'int_2', userInput: '周报整理' },
      ]);
      expect(prompt).toContain('之前的调研');
      expect(prompt).toContain('int_1');
      expect(prompt).toContain('int_2');
    });

    it('解析返回的 ID 列表', () => {
      const bridge = new LlmBridge('claude');
      const ids = (bridge as any).parseRankResult('["int_1", "int_3"]');
      expect(ids).toEqual(['int_1', 'int_3']);
    });

    it('解析失败时返回空数组', () => {
      const bridge = new LlmBridge('claude');
      const ids = (bridge as any).parseRankResult('无法判断');
      expect(ids).toEqual([]);
    });

    it('无候选时直接返回空数组，不调用 LLM', async () => {
      const bridge = new LlmBridge('claude');
      const querySpy = vi.spyOn(bridge as any, 'query');
      const ids = await bridge.rankInteractions('你好', []);
      expect(ids).toEqual([]);
      expect(querySpy).not.toHaveBeenCalled();
    });
  });

  describe('recallPreferences', () => {
    it('builds a semantic preference recall prompt that rejects keyword-only matching', () => {
      const bridge = new LlmBridge('claude');
      const prompt = (bridge as any).buildPreferenceRecallPrompt('这不就是我给你说的图片吗', [
        {
          id: 'pref_feishu',
          scope: 'global',
          subject: null,
          type: 'domain',
          content: '调研报告要生成飞书云文档和在线预览',
        },
      ]);

      expect(prompt).toContain('不要做关键词匹配');
      expect(prompt).toContain('图片');
      expect(prompt).toContain('pref_feishu');
      expect(prompt).toContain('调研报告要生成飞书云文档和在线预览');
    });

    it('parses preference recall decisions and filters invalid ids', () => {
      const bridge = new LlmBridge('claude');
      const result = (bridge as any).parsePreferenceRecallResult(
        '[{"preferenceId":"pref_1","reason":"适用于当前输出格式","score":0.8},{"preferenceId":"missing","reason":"无效","score":0.9}]',
        new Set(['pref_1']),
      );

      expect(result).toEqual([
        {
          preferenceId: 'pref_1',
          reason: '适用于当前输出格式',
          score: 0.8,
        },
      ]);
    });

    it('returns empty decisions when executor says no preference applies', async () => {
      const bridge = new LlmBridge('claude');
      const querySpy = vi.spyOn(bridge, 'query').mockResolvedValue('[]');

      const result = await bridge.recallPreferences('普通闲聊', [
        {
          id: 'pref_1',
          scope: 'global',
          subject: null,
          type: 'domain',
          content: '报告要生成飞书文档',
        },
      ]);

      expect(querySpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual([]);
    });
  });

  describe('command args', () => {
    it('builds codex exec args for non-interactive autonomous runs', () => {
      const bridge = new LlmBridge('codex');
      const args = (bridge as any).buildCommandArgs('你好');

      expect(args[0]).toBe('exec');
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).toContain('--dangerously-bypass-hook-trust');
      expect(args).toContain('--skip-git-repo-check');
      expect(args).toContain('--ephemeral');
      expect(args).toContain('--color');
      expect(args).toContain('never');
      expect(args).toContain('你好');
    });

    it('builds claude args with skip permissions', () => {
      const bridge = new LlmBridge('claude');
      const args = (bridge as any).buildCommandArgs('你好');

      expect(args).toContain('--print');
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('你好');
    });
  });
});
