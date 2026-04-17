import { describe, expect, it } from 'vitest';
import { prepareEditorSubmission } from '../../src/tui/app.js';

describe('prepareEditorSubmission', () => {
  it('returns trimmed user input and clears the editor immediately', () => {
    const result = prepareEditorSubmission({
      text: '  我们之前是不是做了一个调研项目  ',
      cursor: 16,
    });

    expect(result.userInput).toBe('我们之前是不是做了一个调研项目');
    expect(result.nextEditor).toEqual({ text: '', cursor: 0 });
  });
});
