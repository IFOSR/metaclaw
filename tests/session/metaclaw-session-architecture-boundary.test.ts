import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

function readSource(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf-8');
}

describe('MetaclawSession architecture boundaries', () => {
  it('routes natural language decisions only through IntentOrchestrator from the session path', () => {
    const source = readSource('src/session/metaclaw-session.ts');

    expect(source).toContain('getIntentOrchestrator().decide');
    expect(source).not.toContain('semantic-intent-router');
    expect(source).not.toContain('new SemanticIntentRouter');
    expect(source).not.toContain('resolveRoute(');
    expect(source).not.toContain('resolveIntent(');
    expect(source).not.toContain('resolveTaskStateOwnership(');
    expect(source).not.toContain('resolveTaskPriority(');
    expect(source).not.toContain('resolveTaskResumeIntent(');
    expect(source).not.toContain('resolveRouteDecision');
    expect(source).not.toContain('resolveIntentDecision');
    expect(source).not.toContain('buildIntentDecisionFromV2');
    expect(source).not.toContain('inferTaskRouteIntent');
  });

  it('does not bypass or override IntentDecisionV2 with session-level natural-language hard rules', () => {
    const source = readSource('src/session/metaclaw-session.ts');
    const orchestratorSource = readSource('src/core/intent-orchestrator.ts');

    expect(source).not.toContain('shouldBusyFallbackIntentToDurableTask');
    expect(source).not.toContain("decision.interactionType = 'durable_task'");
    expect(orchestratorSource).not.toContain('resolveFocusHintDecision');
    expect(source).not.toContain('maybeHandleNaturalLanguageTaskResume(');
    expect(source).not.toContain('maybeAutoResumeSatisfiedBlockedTask(');
    expect(source).not.toContain('maybeHandlePersistedLastTaskContinuation(');
    expect(source).not.toContain('isConversationalContinuationInstruction(userInput)');
    expect(source).not.toContain('isConversationDerivedWorkInstruction(userInput)');
    expect(source).not.toContain('isExplicitTaskControlReference(userInput)');
    expect(source).not.toContain('applyFocusAwareRouteOverride');
    expect(source).not.toContain('applyFocusAwareIntentOverride');
  });

  it('does not pre-filter IntentOrchestrator recent task candidates through durable regex rules', () => {
    const source = readSource('src/session/metaclaw-session.ts');

    expect(source).not.toContain('const durableTasks = filterDurableTasks(this.taskRuntimeService.listTasks())');
    expect(source).toContain('const recentTasks = this.buildRecentTaskSummaries(this.taskRuntimeService.listTasks())');
  });

  it('uses SchedulerBridge for execution completion and blocking state transitions', () => {
    const source = readSource('src/session/metaclaw-session.ts');
    const coordinatorSource = readSource('src/session/session-execution-coordinator.ts');
    const applicationSource = readSource('src/session/session-task-execution-application-service.ts');

    expect(source).toContain('SessionTaskExecutionApplicationService');
    expect(applicationSource).toContain('sessionExecutionCoordinator.execute');
    expect(source).not.toContain('scheduler.markDispatchStarted');
    expect(source).not.toContain('scheduler.markDispatchFinished');
    expect(source).not.toContain('scheduler.markDispatchBlocked');
    expect(coordinatorSource).toContain('scheduler.markDispatchStarted');
    expect(coordinatorSource).toContain('scheduler.markDispatchFinished');
    expect(coordinatorSource).toContain('scheduler.markDispatchBlocked');
    expect(source).not.toContain("transitionTask(taskId, 'done')");
    expect(source).not.toContain('blockTaskOnVerificationFailure');
    expect(source).not.toContain('blockTaskOnRecoverableFailure');
  });

  it('keeps task-routing parsers, task status formatting, and task clearing presentation out of MetaclawSession', () => {
    const source = readSource('src/session/metaclaw-session.ts');
    const applicationSource = readSource('src/session/session-intent-application-service.ts');

    expect(source).not.toContain('parseTaskClearInstruction');
    expect(source).not.toContain('parseTaskStatusQuery');
    expect(source).not.toContain('formatNaturalLanguageTaskStatus');
    expect(source).not.toContain('taskRuntimeService.formatTaskStatus');
    expect(source).not.toContain('result.output');
    expect(source).not.toContain('presentation.formatTaskStatus');
    expect(source).not.toContain('presentation.formatTaskClearResult');
    expect(applicationSource).toContain('presentation.formatTaskStatus');
    expect(applicationSource).toContain('presentation.formatTaskClearResult');
  });

  it('delegates delivery notifications and blocked recovery formatting to VerificationAndDeliveryService', () => {
    const source = readSource('src/session/metaclaw-session.ts');
    const coordinatorSource = readSource('src/session/session-execution-coordinator.ts');

    expect(source).not.toContain('notifier.notifyTaskCompleted');
    expect(source).not.toContain('notifier.notifyMemoryCandidate');
    expect(source).not.toContain('private notifyMemoryCandidate');
    expect(source).not.toContain('private appendBlockedRecoveryCompletionBlock');
    expect(source).not.toContain('verificationAndDeliveryService.deliverTaskCompletion');
    expect(source).toContain('memoryCaptureService');
    expect(coordinatorSource).toContain('verificationAndDeliveryService.deliverTaskCompletion');
    expect(coordinatorSource).toContain('verificationAndDeliveryService.appendBlockedRecoveryCompletionBlock');
    expect(coordinatorSource).toContain('await this.deps.verificationAndDeliveryService.prepareAsync');
    expect(source).not.toContain('this.verificationAndDeliveryService.prepare({');
  });

  it('does not own task execution planning or natural-language resume resolution', () => {
    const source = readSource('src/session/metaclaw-session.ts');

    expect(source).not.toContain('planTaskExecution(');
    expect(source).not.toContain('memoryContextService.prepareExecutionContext');
    expect(source).not.toContain('executionRuntime.run');
    expect(source).not.toContain('executorRoutingCoordinator.resolveForTask');
    expect(source).not.toContain('executeLegacyResumeResolutionFromIntent');
    expect(source).not.toContain('executeNaturalLanguageTaskResumeFromIntent');
    expect(source).not.toContain('executeBlockedRecoveryFromIntent');
    expect(source).not.toContain('resolveLegacyResumeIntent');
    expect(source).not.toContain('decideResumeTarget');
  });

  it('delegates intent decision application and task-control branches outside the session facade', () => {
    const source = readSource('src/session/metaclaw-session.ts');
    const applicationSource = readSource('src/session/session-intent-application-service.ts');

    expect(source).toContain('SessionIntentApplicationService');
    expect(source).toContain('sessionIntentApplicationService.apply');
    expect(source).not.toContain("decision.interactionType === 'task_control'");
    expect(source).not.toContain("decision.interactionType === 'direct_reply'");
    expect(source).not.toContain('private async applyResumePlanResult');
    expect(source).not.toContain('private async handleReferencedTaskFromIntent');
    expect(source).not.toContain('private async executeLastTaskContinuationFromIntent');
    expect(source).not.toContain('private normalizeTaskStatusScope');
    expect(source).not.toContain('private normalizeTaskClearScope');
    expect(source).not.toContain('inlineResourceContext.normalizedGoal.slice');
    expect(applicationSource).toContain("decision.interactionType === 'task_control'");
    expect(applicationSource).toContain('applyResumePlanResult');
    expect(applicationSource).toContain('normalizeTaskStatusScope');
    expect(applicationSource).toContain('normalizeTaskClearScope');
  });

  it('does not persist interactions, route events, or memory audit records directly', () => {
    const source = readSource('src/session/metaclaw-session.ts');

    expect(source).not.toContain('INSERT INTO interactions');
    expect(source).not.toContain('ExecutorRouteEventRepo');
    expect(source).not.toContain('MemoryAuditEventRepo');
  });

  it('keeps high-confidence memory capture outside the session facade', () => {
    const source = readSource('src/session/metaclaw-session.ts');

    expect(source).not.toContain('extractHighConfidencePreferenceCandidates');
    expect(source).not.toContain('appendHighConfidencePreferenceCandidateBlocks');
    expect(source).not.toContain('recordMemoryAuditEvent');
  });

  it('delegates recall review policy, audit, and display application outside the session facade', () => {
    const source = readSource('src/session/metaclaw-session.ts');
    const applicationSource = readSource('src/session/session-task-execution-application-service.ts');

    expect(source).toContain('RecallReviewApplicationService');
    expect(applicationSource).toContain('recallReviewApplicationService.apply');
    expect(source).not.toContain('RecallPolicyService');
    expect(source).not.toContain('RecallReviewPolicyRepo');
    expect(source).not.toContain('createRecallPolicyService');
    expect(source).not.toContain('prepareRecallReviewContext({');
    expect(source).not.toContain('recordSuppressedRecallMemoryAuditEvents');
    expect(source).not.toContain('appendAutoAppliedMemoryBlock');
    expect(source).not.toContain('appendSuppressedRecallBlock');
    expect(source).not.toContain("action: 'suppress'");
    expect(source).not.toContain("action: 'auto_apply'");
  });

  it('keeps guidance, watchdog, and queue snapshot formatting outside the session facade', () => {
    const source = readSource('src/session/metaclaw-session.ts');

    expect(source).toContain('SessionPresentationService');
    expect(source).not.toContain('private formatTaskPoolWatchdogReminder');
    expect(source).not.toContain('private describeBlockedTaskMissingCondition');
    expect(source).not.toContain('private appendGuidanceBlock');
    expect(source).not.toContain('private appendProposalBlock');
    expect(source).not.toContain('private appendRecallReviewBlock');
    expect(source).not.toContain('private appendLastTaskAutoDecisionBlock');
    expect(source).not.toContain('private buildResumeGuidanceReasons');
    expect(source).not.toContain('private formatTaskQueueSnapshotEntry');
    expect(source).not.toContain('private queueSnapshotStatusRank');
    expect(source).not.toContain('private defaultQueueSnapshotReason');
    expect(source).not.toContain('private formatExecutorRegisterWizardSummary');
    expect(source).not.toContain('private buildVerificationFailureHint');
    expect(source).not.toContain('private buildRecoverableFailureHint');
  });

  it('keeps executor administration, profile persistence, and runtime inference outside the session facade', () => {
    const source = readSource('src/session/metaclaw-session.ts');

    expect(source).toContain('ExecutorAdminService');
    expect(source).toContain('ExecutorProfileService');
    expect(source).not.toContain("from 'child_process'");
    expect(source).not.toContain('spawnSync');
    expect(source).not.toContain('ExecutorProfileRepo');
    expect(source).not.toContain('seedDefaultExecutorProfiles');
    expect(source).not.toContain('private startExecutorRegisterWizard');
    expect(source).not.toContain('private handlePendingExecutorRegisterWizard');
    expect(source).not.toContain('private completeExecutorRegisterWizard');
    expect(source).not.toContain('private inferExecutorRuntimeFromProjectUrl');
    expect(source).not.toContain('private fetchText');
  });

  it('keeps executor routing, progress observation, and workspace filesystem effects outside the session facade', () => {
    const source = readSource('src/session/metaclaw-session.ts');

    expect(source).toContain('ExecutorRoutingCoordinator');
    expect(source).toContain('ExecutionProgressService');
    expect(source).toContain('WorkspaceTargetService');
    expect(source).not.toContain("from 'fs'");
    expect(source).not.toContain('mkdirSync');
    expect(source).not.toContain('SkillUsageEventRepo');
    expect(source).not.toContain('parseSkillUsageEventLine');
    expect(source).not.toContain('lastProgressLineByTask');
    expect(source).not.toContain('private resolveExecutorForTask');
    expect(source).not.toContain('private appendExecutorRoutingDecision');
    expect(source).not.toContain('private formatExecutionPlanRunLabel');
    expect(source).not.toContain('private formatExecutionPlanDisplayLabel');
    expect(source).not.toContain('private resolveExecutionPlanRaceExecutorNames');
    expect(source).not.toContain('private ensureWorkspaceTargets');
  });

  it('does not keep legacy pending confirmation state machines in MetaclawSession', () => {
    const source = readSource('src/session/metaclaw-session.ts');

    expect(source).not.toContain('pendingRiskConfirmation');
    expect(source).not.toContain('pendingPreferenceConfirmation');
    expect(source).not.toContain('pendingProposalConfirmation');
    expect(source).not.toContain('pendingLastTaskConfirmation');
    expect(source).not.toContain('pendingRecallReview');
    expect(source).not.toContain('handlePendingPreferenceConfirmation');
    expect(source).not.toContain('handlePendingProposalConfirmation');
    expect(source).not.toContain('handlePendingLastTaskConfirmation');
    expect(source).not.toContain('handlePendingRecallReview');
  });

  it('delegates normal conversation execution outside the session facade', () => {
    const source = readSource('src/session/metaclaw-session.ts');

    expect(source).toContain('ConversationRuntimeService');
    expect(source).not.toContain('private async handleConversationInput');
    expect(source).not.toContain('private buildConversationTask');
    expect(source).not.toContain('deps.executor.execute({');
  });

  it('delegates task execution scheduling glue outside the session facade', () => {
    const source = readSource('src/session/metaclaw-session.ts');
    const applicationSource = readSource('src/session/session-task-execution-application-service.ts');

    expect(source).toContain('SessionTaskExecutionApplicationService');
    expect(source).toContain('taskExecutionApplicationService.prepareTaskExecution');
    expect(source).toContain('taskExecutionApplicationService.dispatchTask');
    expect(source).not.toContain('approvedRecallSelections');
    expect(source).not.toContain('private async submitScheduledTask');
    expect(source).not.toContain('private buildFallbackExecutionRequest');
    expect(source).not.toContain('private async executeTask');
    expect(source).not.toContain('private maybeAppendExecutionGuidance');
    expect(applicationSource).toContain('approvedRecallSelections');
    expect(applicationSource).toContain('buildFallbackExecutionRequest');
    expect(applicationSource).toContain('sessionExecutionCoordinator.execute');
  });
});

describe('TaskRuntimeService architecture boundaries', () => {
  it('does not format UI text or abort executors directly', () => {
    const source = readSource('src/task/task-runtime-service.ts');

    expect(source).not.toContain('formatTaskStatus');
    expect(source).not.toContain('formatTaskClearResult');
    expect(source).not.toContain('deps.executor.abort');
  });
});
