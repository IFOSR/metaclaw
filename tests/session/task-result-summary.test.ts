import { describe, expect, it } from 'vitest';
import { VerificationAndDeliveryService } from '../../src/core/verification-and-delivery-service.js';

describe('task result summary delivery', () => {
  it('does not use an empty quoted file path as the task summary', () => {
    const result = new VerificationAndDeliveryService().prepare({
      output: '已创建文件：``\n保存路径：/tmp/metaclaw-output/smoke-result.md',
      durationMs: 100,
      userPrompt: '生成文件',
      workspaceContext: {
        allowFilesystem: true,
        workingDirectory: '/tmp/metaclaw-output',
        targetPaths: ['/tmp/metaclaw-output'],
      },
      preferences: [],
      nextStep: '无后续建议',
    });

    expect(result.summary).not.toBe('已创建文件：``');
    expect(result.summary).toContain('/tmp/metaclaw-output');
  });
});
