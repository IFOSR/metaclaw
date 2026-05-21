import { describe, expect, it } from 'vitest';
import {
  extractHighConfidencePreferenceCandidates,
  isHighRiskMemoryCandidate,
} from '../../src/session/session-helpers.js';

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

  it('classifies external side-effect memory candidates as high risk', () => {
    expect(isHighRiskMemoryCandidate('以后凡是报告都要自动发给客户')).toBe(true);
    expect(isHighRiskMemoryCandidate('以后默认删除临时文件')).toBe(true);
    expect(isHighRiskMemoryCandidate('复杂方案默认先给结论，再列执行细节')).toBe(false);
  });
});
