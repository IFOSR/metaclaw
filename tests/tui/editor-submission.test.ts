import { describe, expect, it } from 'vitest';
import {
  COMPOSER_PANEL_BORDER_COLOR,
  META_TEXT_COLOR,
  PROMPT_COLOR,
  RUNTIME_SUMMARY_COLOR,
  buildRenderLines,
  formatRenderLine,
  getLineColor,
  prepareEditorSubmission,
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
});
