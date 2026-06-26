import { describe, expect, it } from 'vitest';
import {
  COMPOSER_PANEL_BORDER_COLOR,
  META_TEXT_COLOR,
  PROMPT_COLOR,
  RUNTIME_SUMMARY_COLOR,
  buildRenderLines,
  createInputHistoryState,
  formatRenderLine,
  getLineColor,
  getCommandSuggestions,
  applyCommandSuggestion,
  applyEditorInput,
  applyEditorInputChunk,
  getComposerStatus,
  prepareEditorSubmission,
  recallNextInput,
  recallPreviousInput,
  recordInputHistory,
} from '../../src/tui/app.js';

describe('prepareEditorSubmission', () => {
  it('returns trimmed user input and clears the editor immediately', () => {
    const result = prepareEditorSubmission({
      text: '  我们之前是不是做了一个调研项目  ',
      cursor: 16,
    });

    expect(result.userInput).toBe('我们之前是不是做了一个调研项目');
    expect(result.nextEditor).toEqual({ text: '', cursor: 0 });
  });

  it('adds a visual paragraph break before a committed user input when transcript history already exists', () => {
    const rendered = buildRenderLines([
      '→ 已恢复最近任务',
      '> /task parked',
      '→ 任务 #task_123 已挂起',
    ]).map(formatRenderLine);

    expect(rendered).toEqual([
      '→ 已恢复最近任务',
      ' ',
      '> /task parked',
      '→ 任务 #task_123 已挂起',
    ]);
  });

  it('does not add a leading blank line when the transcript starts with user input', () => {
    const rendered = buildRenderLines([
      '> 新任务',
      '→ 任务 #task_123 已创建：新任务',
    ]).map(formatRenderLine);

    expect(rendered).toEqual([
      '> 新任务',
      '→ 任务 #task_123 已创建：新任务',
    ]);
  });

  it('uses a high-contrast palette for transcript and meta text on the dark terminal background', () => {
    expect(getLineColor('system')).toBe('whiteBright');
    expect(getLineColor('context')).toBe('cyanBright');
    expect(getLineColor('agent')).toBe('blueBright');
    expect(getLineColor('warning')).toBe('yellowBright');
    expect(META_TEXT_COLOR).toBe('whiteBright');
    expect(RUNTIME_SUMMARY_COLOR).toBe('cyanBright');
    expect(COMPOSER_PANEL_BORDER_COLOR).toBe('whiteBright');
    expect(PROMPT_COLOR).toBe('greenBright');
  });

  it('prefers the concrete running executor over transient submission processing status', () => {
    expect(getComposerStatus({
      output: [],
      currentTaskId: 'task_running',
      currentTask: {
        id: 'task_running',
        title: '运行中的任务',
        status: 'running',
      },
      runtimeState: {
        runningTaskId: 'task_running',
        runningExecutorName: 'codex-cli',
        readyTaskIds: [],
        parkedTaskIds: [],
        blockedTaskIds: [],
        lastEvent: '开始执行任务 #task_running',
      },
      latestGuidance: null,
    }, [], 'codex-cli', true)).toBe('running codex-cli');
  });

  it('recalls submitted input history while preserving the current draft', () => {
    let history = createInputHistoryState();
    history = recordInputHistory(history, '第一条任务', { text: '', cursor: 0 });
    history = recordInputHistory(history, '第二条任务', { text: '', cursor: 0 });

    const firstRecall = recallPreviousInput(history, { text: '当前草稿', cursor: 4 });
    expect(firstRecall.editor).toEqual({ text: '第二条任务', cursor: 5 });

    const secondRecall = recallPreviousInput(firstRecall.state, firstRecall.editor);
    expect(secondRecall.editor).toEqual({ text: '第一条任务', cursor: 5 });

    const nextRecall = recallNextInput(secondRecall.state, secondRecall.editor);
    expect(nextRecall.editor).toEqual({ text: '第二条任务', cursor: 5 });

    const draftRecall = recallNextInput(nextRecall.state, nextRecall.editor);
    expect(draftRecall.editor).toEqual({ text: '当前草稿', cursor: 4 });
  });

  it('deduplicates adjacent input history entries and keeps the latest 100 commands', () => {
    let history = createInputHistoryState();
    history = recordInputHistory(history, '重复任务', { text: '', cursor: 0 });
    history = recordInputHistory(history, '重复任务', { text: '', cursor: 0 });
    for (let index = 0; index < 101; index += 1) {
      history = recordInputHistory(history, `任务 ${index}`, { text: '', cursor: 0 });
    }

    expect(history.entries).toHaveLength(100);
    expect(history.entries[0]).toBe('任务 1');
    expect(history.entries[99]).toBe('任务 100');
  });

  it('filters slash command suggestions by command or alias prefix', () => {
    expect(getCommandSuggestions({ text: '/', cursor: 1 }).map(item => item.command))
      .toEqual(expect.arrayContaining(['/task', '/tasks', '/memory', '/help']));

    expect(getCommandSuggestions({ text: '/ta', cursor: 3 }).map(item => item.command))
      .toEqual(['/task', '/tasks']);

    expect(getCommandSuggestions({ text: '/q', cursor: 2 }).map(item => item.command))
      .toEqual(['/exit']);

    expect(getCommandSuggestions({ text: '/task ', cursor: 6 })).toEqual([]);
  });

  it('applies a selected slash command into the editor without submitting it', () => {
    const [suggestion] = getCommandSuggestions({ text: '/ta', cursor: 3 });
    expect(applyCommandSuggestion({ text: '/ta', cursor: 3 }, suggestion!))
      .toEqual({ text: '/task ', cursor: 6 });
  });

  it('edits text at the cursor while preserving spaces and supporting backward and forward deletion', () => {
    let editor = { text: '请整理  报告', cursor: 3 };

    editor = applyEditorInput(editor, '详细 ', {});
    expect(editor).toEqual({ text: '请整理详细   报告', cursor: 6 });

    editor = applyEditorInput(editor, '', { leftArrow: true });
    editor = applyEditorInput(editor, '', { leftArrow: true });
    expect(editor).toEqual({ text: '请整理详细   报告', cursor: 4 });

    editor = applyEditorInput(editor, '', { backspace: true });
    expect(editor).toEqual({ text: '请整理细   报告', cursor: 3 });

    editor = applyEditorInput(editor, '', { forwardDelete: true });
    expect(editor).toEqual({ text: '请整理   报告', cursor: 3 });
  });

  it('treats Ink key.delete with empty input as normal Backspace because terminals collapse DEL into delete', () => {
    expect(applyEditorInput({ text: 'abcdef', cursor: 3 }, '', { delete: true }))
      .toEqual({ text: 'abdef', cursor: 2 });
  });

  it('treats DEL and BS control characters as backward deletion even when the terminal also marks delete', () => {
    expect(applyEditorInput({ text: 'abcdef', cursor: 3 }, '\u007f', { delete: true }))
      .toEqual({ text: 'abdef', cursor: 2 });

    expect(applyEditorInput({ text: 'abcdef', cursor: 3 }, '\b', { delete: true }))
      .toEqual({ text: 'abdef', cursor: 2 });
  });

  it('inserts multiline text without submitting and moves the cursor across newline boundaries', () => {
    let editor = { text: '第一行\n第三行', cursor: 4 };

    editor = applyEditorInput(editor, '第二行\n', {});
    expect(editor).toEqual({ text: '第一行\n第二行\n第三行', cursor: 8 });

    editor = applyEditorInput(editor, '', { leftArrow: true });
    editor = applyEditorInput(editor, '', { leftArrow: true });
    editor = applyEditorInput(editor, '改', {});

    expect(editor).toEqual({ text: '第一行\n第二改行\n第三行', cursor: 7 });
  });

  it('treats Ctrl+J as a terminal-stable newline insertion shortcut', () => {
    const editor = applyEditorInput({ text: '第一行第二行', cursor: 3 }, 'j', { ctrl: true });

    expect(editor).toEqual({ text: '第一行\n第二行', cursor: 4 });
  });

  it('treats Ctrl+Enter as newline insertion when terminals normalize Ctrl+J as return+ctrl', () => {
    const editor = applyEditorInput({ text: '第一行第二行', cursor: 3 }, '', { return: true, ctrl: true });

    expect(editor).toEqual({ text: '第一行\n第二行', cursor: 4 });
  });

  it('parses raw terminal chunks containing arrow, delete, and backspace escape sequences', () => {
    const editor = applyEditorInputChunk(
      { text: '', cursor: 0 },
      '第一行\n第二  错行\u001b[D\u001b[D\u001b[3~\u007f补  充',
    );

    expect(editor).toEqual({ text: '第一行\n第二 补  充行', cursor: 11 });
  });
});
