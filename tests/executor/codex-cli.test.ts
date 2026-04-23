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

    it('file-generation tasks should force file output and ban full content echoing', () => {
      const prompt = getPrompt(adapter, makeInput({
        executionContextBundle: {
          mode: 'fresh',
          taskBrief: {
            id: 'task_1',
            title: '生成活动页',
            goal: '生成 HTML 文件并存入任务目录',
            status: 'ready',
            summary: '',
          },
          memoryContext: {
            explicitUserInstruction: '生成一个 html 文件',
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
            targetPaths: ['/repo/metaclaw-tasks/task_1'],
          },
          executionInstructions: [
            '必须把结果写入本地文件系统，不要只在回复中描述结果',
            '不要在回复中粘贴或打印完整文件内容，只返回简短摘要和最终文件路径',
            '目标目录：/repo/metaclaw-tasks/task_1',
          ],
        },
      }));

      expect(prompt).toContain('可以访问当前项目工作目录');
      expect(prompt).toContain('/repo/metaclaw-tasks/task_1');
      expect(prompt).toContain('不要在回复中粘贴或打印完整文件内容');
      expect(prompt).not.toContain('不要读取或访问本地文件系统和工作目录');
    });

    it('injects text material excerpts into the prompt when available', () => {
      const prompt = getPrompt(adapter, makeInput({
        executionContextBundle: {
          mode: 'fresh',
          taskBrief: {
            id: 'task_1',
            title: 'Phoenix 周报',
            goal: '整理 Phoenix 周报',
            status: 'ready',
            summary: '',
          },
          memoryContext: {
            explicitUserInstruction: '结合材料整理 Phoenix 周报结论',
            resolvedPreferences: [],
          },
          historyContext: {
            taskTurns: [],
            sessionTurns: [],
            relatedTurns: [],
          },
          materialContext: {
            resources: ['/repo/materials/phoenix-weekly.md'],
            textSnippets: [
              {
                path: '/repo/materials/phoenix-weekly.md',
                content: '# Phoenix Weekly\n本周完成核心模块联调，主线推进稳定。',
              },
            ],
          },
          executionInstructions: [],
        },
      }));

      expect(prompt).toContain('关联材料：/repo/materials/phoenix-weekly.md');
      expect(prompt).toContain('材料摘录：');
      expect(prompt).toContain('核心模块联调');
    });

    it('separates local files and web links in the prompt materials section', () => {
      const prompt = getPrompt(adapter, makeInput({
        executionContextBundle: {
          mode: 'fresh',
          taskBrief: {
            id: 'task_1',
            title: 'Phoenix 周报',
            goal: '整理 Phoenix 周报',
            status: 'ready',
            summary: '',
          },
          memoryContext: {
            explicitUserInstruction: '整理 Phoenix 周报',
            resolvedPreferences: [],
          },
          historyContext: {
            taskTurns: [],
            sessionTurns: [],
            relatedTurns: [],
          },
          materialContext: {
            resources: ['/repo/materials/phoenix-weekly.md', 'https://example.com/phoenix-weekly'],
            textSnippets: [],
          },
          executionInstructions: [],
        },
      }));

      expect(prompt).toContain('材料概览：');
      expect(prompt).toContain('材料状态：');
      expect(prompt).toContain('本地文件材料：/repo/materials/phoenix-weekly.md');
      expect(prompt).toContain('网页链接材料：https://example.com/phoenix-weekly');
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
