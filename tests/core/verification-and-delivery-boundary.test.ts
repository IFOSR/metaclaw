import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

function readSource(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf-8');
}

function coreFileExists(path: string): boolean {
  return existsSync(resolve(projectRoot, path));
}

describe('verification and delivery architecture boundaries', () => {
  it('moves artifact extraction and Feishu fallback artifact creation behind VerificationAndDeliveryService', () => {
    const sessionSource = readSource('src/session/metaclaw-session.ts');
    const coordinatorSource = readSource('src/session/session-execution-coordinator.ts');
    const deliverySource = readSource('src/delivery/verification-and-delivery-service.ts');

    expect(sessionSource).not.toContain('verificationAndDeliveryService.prepare');
    expect(coordinatorSource).toContain('verificationAndDeliveryService.prepareAsync');
    expect(sessionSource).not.toContain('collectArtifactPaths(');
    expect(sessionSource).not.toContain('ensureFeishuDocumentArtifact(');
    expect(sessionSource).not.toContain('buildTaskResultSummary(');
    expect(deliverySource).toContain('export class VerificationAndDeliveryService');
    expect(deliverySource).toContain('export class HeuristicVerifier');
    expect(deliverySource).toContain('export class AggregationVerifier');
    expect(deliverySource).toContain('ExecutionAggregator');
    expect(deliverySource).toContain('feishu-document.md');
    expect(deliverySource).toContain('deliverTaskCompletion');
    expect(coreFileExists('src/core/verification-and-delivery-service.ts')).toBe(false);
    expect(sessionSource).not.toContain('notifyTaskCompleted(');
  });

  it('keeps verification and delivery independent from executor creation and LLM routing', () => {
    const deliverySource = readSource('src/delivery/verification-and-delivery-service.ts');
    const runtimeSource = readSource('src/core/execution-runtime.ts');

    expect(deliverySource).not.toContain('createExecutorByName');
    expect(deliverySource).not.toContain('new CustomCliExecutorAdapter');
    expect(deliverySource).not.toContain('llmBridge');
    expect(deliverySource).not.toContain('resolveIntent');
    expect(runtimeSource).not.toContain('resolveIntent');
    expect(runtimeSource).not.toContain('resolveRoute');
  });
});
