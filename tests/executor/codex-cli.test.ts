import { describe, expect, it } from 'vitest';
import { CodexCliAdapter } from '../../src/executor/codex-cli.js';

describe('CodexCliAdapter', () => {
  describe('buildContextPrompt', () => {
    function getPrompt(adapter: CodexCliAdapter, input: any): string {
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
        executionContextBundle: overrides.executionContextBundle,
      };
    }

    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 300 });

    it('无历史时应包含边界声明', () => {
      const prompt = getPrompt(adapter, makeInput());
      expect(prompt).toContain('无相关对话历史');
    });

    it('prompt 应包含系统边界指令', () => {
      const prompt = getPrompt(adapter, makeInput());
      expect(prompt).toContain('不要读取或访问本地文件系统和工作目录');
    });

    it('file archive tasks should allow writing to the workspace target directory', () => {
      const prompt = getPrompt(adapter, makeInput({
        executionContextBundle: {
          mode: 'fresh',
          taskBrief: {
            id: 'task_1',
            title: '归档 harness 分析',
            goal: '保存文章到 projects 目录',
            status: 'ready',
            summary: '',
          },
          memoryContext: {
            explicitUserInstruction: '存档到当前项目的projects目录下',
            resolvedPreferences: [],
          },
          historyContext: {
            taskTurns: [],
            sessionTurns: [],
            relatedTurns: [],
          },
          materialContext: {
            resources: [],
          },
          workspaceContext: {
            allowFilesystem: true,
            workingDirectory: '/repo',
            targetPaths: ['/repo/projects'],
          },
          executionInstructions: [
            '必须把结果写入本地文件系统，不要只在回复中描述结果',
            '目标目录：/repo/projects',
          ],
        },
      }));

      expect(prompt).toContain('可以访问当前项目工作目录');
      expect(prompt).toContain('/repo/projects');
      expect(prompt).not.toContain('不要读取或访问本地文件系统和工作目录');
    });
  });

  describe('spawn args', () => {
    it('uses codex exec with full permissions by default', () => {
      const adapter = new CodexCliAdapter({ command: 'codex', timeout: 300 });
      const args = (adapter as any).buildSpawnArgs('test prompt');

      expect(args[0]).toBe('exec');
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).toContain('test prompt');
    });
  });
});
