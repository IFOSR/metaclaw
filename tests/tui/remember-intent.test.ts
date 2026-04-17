import { describe, expect, it } from 'vitest';
import { parseExplicitRemember } from '../../src/tui/app.js';

describe('parseExplicitRemember', () => {
  it('extracts direct remember content from natural language input', () => {
    expect(parseExplicitRemember('记住：给张总发邮件用正式语气')).toBe('给张总发邮件用正式语气');
  });

  it('returns null for non-remember inputs', () => {
    expect(parseExplicitRemember('帮我写一封邮件')).toBeNull();
  });
});
