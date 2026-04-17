import { describe, it, expect, vi } from 'vitest';
import { LlmBridge } from '../../src/core/llm-bridge.js';

describe('LlmBridge', () => {
  describe('resolveIntent', () => {
    it('应构造包含任务列表的 prompt', () => {
      const bridge = new LlmBridge('claude');
      const prompt = (bridge as any).buildIntentPrompt('之前帮我比较的那两个开源项目', [
        { id: 'task_1', title: 'hermes vs openclaw 调研', goal: '对比分析', summary: '已完成对比' },
        { id: 'task_2', title: '周报整理', goal: '整理本周工作', summary: '' },
      ]);
      expect(prompt).toContain('之前帮我比较的那两个开源项目');
      expect(prompt).toContain('task_1');
      expect(prompt).toContain('hermes vs openclaw');
      expect(prompt).toContain('task_2');
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

  describe('command args', () => {
    it('builds codex exec args with bypassed approvals and sandbox', () => {
      const bridge = new LlmBridge('codex');
      const args = (bridge as any).buildCommandArgs('你好');

      expect(args[0]).toBe('exec');
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
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
