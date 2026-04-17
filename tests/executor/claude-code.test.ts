import { describe, it, expect } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/executor/claude-code.js';

describe('ClaudeCodeAdapter', () => {
  describe('buildContextPrompt', () => {
    function getPrompt(adapter: ClaudeCodeAdapter, input: any): string {
      // Access private method for testing
      return (adapter as any).buildContextPrompt(input);
    }

    function makeInput(overrides: Record<string, any> = {}) {
      return {
        task: {
          id: 'task_1',
          title: '测试任务',
          goal: '测试目标',
          summary: '',
          resources: [],
          ...overrides.task,
        },
        preferences: overrides.preferences ?? [],
        userPrompt: overrides.userPrompt ?? '你好',
        conversationHistory: overrides.conversationHistory ?? [],
      };
    }

    const adapter = new ClaudeCodeAdapter({ command: 'claude', timeout: 300 });

    it('无历史时应包含边界声明', () => {
      const prompt = getPrompt(adapter, makeInput());
      expect(prompt).toContain('无相关对话历史');
    });

    it('有历史时不应包含边界声明', () => {
      const prompt = getPrompt(adapter, makeInput({
        conversationHistory: [{
          taskId: 'task_1', userInput: '之前的问题', systemOutput: '之前的回答',
          createdAt: '2026-04-12T10:00:00Z', source: 'task',
        }],
      }));
      expect(prompt).not.toContain('无相关对话历史');
    });

    it('prompt 应包含系统边界指令，禁止读取本地文件系统', () => {
      const prompt = getPrompt(adapter, makeInput());
      expect(prompt).toContain('不要读取或访问本地文件系统和工作目录');
    });

    it('prompt 应要求跟随用户语言回复', () => {
      const prompt = getPrompt(adapter, makeInput());
      expect(prompt).toContain('使用与用户相同的语言回复');
    });
  });

  describe('spawn args', () => {
    it('应使用 --dangerously-skip-permissions 授予完整权限', () => {
      const adapter = new ClaudeCodeAdapter({ command: 'claude', timeout: 300 });
      const args = (adapter as any).buildSpawnArgs('test prompt');
      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('应包含 --print 参数', () => {
      const adapter = new ClaudeCodeAdapter({ command: 'claude', timeout: 300 });
      const args = (adapter as any).buildSpawnArgs('test prompt');
      expect(args).toContain('--print');
    });
  });
});
