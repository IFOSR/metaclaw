import { describe, expect, it } from 'vitest';
import { extractHighConfidencePreferenceCandidates } from '../../src/session/session-helpers.js';

describe('extractHighConfidencePreferenceCandidates', () => {
  it('extracts future default workflow rules from user input', () => {
    expect(extractHighConfidencePreferenceCandidates(
      '以后凡是长篇调研、人物研究、竞品分析，默认输出 Markdown 文件，并在聊天中只给摘要和文件路径',
    )).toEqual([
      '凡是长篇调研、人物研究、竞品分析，默认输出 Markdown 文件，并在聊天中只给摘要和文件路径',
    ]);
  });

  it('extracts explicit model-identified preferences from executor output', () => {
    expect(extractHighConfidencePreferenceCandidates(
      '你明确偏好：**长篇调研型输出应该保存成本地 Markdown 文件**，不要只放在聊天里。',
    )).toEqual([
      '长篇调研型输出应该保存成本地 Markdown 文件',
    ]);
  });
});
