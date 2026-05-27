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
});
