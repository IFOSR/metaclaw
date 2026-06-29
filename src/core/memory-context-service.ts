// Memory context module that prepares recall selections and execution context bundles for tasks.
import type { ConversationTurn } from '../executor/adapter.js';
import type { MemoryEngine } from './memory-engine.js';
import type { ContextRecaller } from './context-recaller.js';
import { extractInlineResourceMatches, stripInlineResourceMatches } from '../intent/inline-resource-normalizer.js';
import type { ResumeContextBuilder } from './resume-context-builder.js';
import { MemoryApplicabilityAction } from './types.js';
import type {
  ExecutionContextBundle,
  Preference,
  PreferenceMemoryCandidate,
  ResolvedPreference,
  TaskMemoryCandidate,
} from './types.js';

export interface ExecutionRecallSelection {
  authoritative: boolean;
  resolvedPreferences: ResolvedPreference[];
  relatedTaskIds: string[];
  acceptedMemoryResources: string[];
}

export interface MemoryContextServiceInput {
  taskId: string;
  contextTaskId: string;
  sessionId: string;
  userPrompt: string;
  executionMode: ExecutionContextBundle['mode'];
  schedulingReason?: string;
  newlyProvidedResources?: string[];
  includeRecentConversationContext?: boolean;
  approvedRecallSelection?: ExecutionRecallSelection | null;
}

export interface MemoryContextServiceResult {
  keywords: string[];
  preferences: Preference[];
  conversationHistory: ConversationTurn[];
  executionContextBundle: ExecutionContextBundle;
  resolvedPreferences: ResolvedPreference[];
}

export interface RecallReviewContextInput {
  taskId: string;
  userPrompt: string;
}

export interface RecallReviewContextResult {
  autoAppliedPreferenceCandidates: PreferenceMemoryCandidate[];
  reviewPreferenceCandidates: PreferenceMemoryCandidate[];
  autoAppliedTaskCandidates: TaskMemoryCandidate[];
  reviewTaskCandidates: TaskMemoryCandidate[];
}

export interface InlineResourceNormalizationResult {
  normalizedGoal: string;
  resources: string[];
}

export interface MemoryContextServiceDeps {
  memoryEngine: MemoryEngine;
  contextRecaller: ContextRecaller;
  resumeContextBuilder: ResumeContextBuilder;
}

export class MemoryContextService {
  constructor(private readonly deps: MemoryContextServiceDeps) {}

  recallConversationContext(input: { sessionId: string; userInput: string; taskId?: string }): Promise<ConversationTurn[]> {
    return this.deps.contextRecaller.recallAsync({
      taskId: input.taskId ?? '',
      sessionId: input.sessionId,
      userInput: input.userInput,
    });
  }

  async prepareExecutionContext(input: MemoryContextServiceInput): Promise<MemoryContextServiceResult> {
    const keywords = this.extractKeywords(input.userPrompt);
    const approvedRecallSelection = input.approvedRecallSelection ?? {
      authoritative: false,
      resolvedPreferences: [],
      relatedTaskIds: [],
      acceptedMemoryResources: [],
    };
    const preferences = approvedRecallSelection.authoritative
      ? this.deps.memoryEngine.list().filter(preference =>
          approvedRecallSelection.resolvedPreferences.some(resolved => resolved.id === preference.id)
        )
      : this.deps.memoryEngine.recall({
          taskId: input.taskId,
          keywords,
          userInput: input.userPrompt,
        });

    const conversationHistory = await this.deps.contextRecaller.recallAsync({
      taskId: input.contextTaskId,
      sessionId: input.sessionId,
      userInput: input.userPrompt,
    });

    const executionContextBundle = await this.deps.resumeContextBuilder.build({
      taskId: input.taskId,
      mode: input.executionMode,
      userInput: input.userPrompt,
      sessionId: input.sessionId,
      schedulingReason: input.schedulingReason,
      newlyProvidedResources: input.newlyProvidedResources,
      resolvedPreferencesOverride: approvedRecallSelection.authoritative
        ? approvedRecallSelection.resolvedPreferences
        : undefined,
      relatedTaskIdsOverride: approvedRecallSelection.authoritative
        ? approvedRecallSelection.relatedTaskIds
        : undefined,
      acceptedMemoryResources: approvedRecallSelection.authoritative
        ? approvedRecallSelection.acceptedMemoryResources
        : undefined,
      includeRecentConversationContext: input.includeRecentConversationContext,
    });

    return {
      keywords,
      preferences,
      conversationHistory,
      executionContextBundle,
      resolvedPreferences: executionContextBundle.memoryContext.resolvedPreferences,
    };
  }

  async prepareRecallReviewContext(input: RecallReviewContextInput): Promise<RecallReviewContextResult> {
    const recallResult = await this.deps.memoryEngine.recallForReview({
      taskId: input.taskId,
      keywords: this.extractKeywords(input.userPrompt),
      userInput: input.userPrompt,
    });

    return {
      autoAppliedPreferenceCandidates: recallResult.preferenceCandidates.filter(candidate =>
        candidate.applicabilityAction === MemoryApplicabilityAction.AUTO_APPLY
      ),
      reviewPreferenceCandidates: recallResult.preferenceCandidates.filter(candidate =>
        candidate.applicabilityAction !== MemoryApplicabilityAction.AUTO_APPLY
      ),
      autoAppliedTaskCandidates: [],
      reviewTaskCandidates: recallResult.taskCandidates,
    };
  }

  buildAcceptedRecallSelection(
    preferenceCandidates: PreferenceMemoryCandidate[],
    taskCandidates: TaskMemoryCandidate[],
  ): ExecutionRecallSelection {
    return {
      authoritative: true,
      resolvedPreferences: preferenceCandidates.map(candidate => ({
        id: candidate.preferenceId,
        content: candidate.summary,
        scope: candidate.scope,
        confidence: Math.min(1, candidate.score / 100),
        reason: candidate.reason,
      })),
      relatedTaskIds: Array.from(new Set(taskCandidates.map(candidate => candidate.taskId))),
      acceptedMemoryResources: Array.from(new Set(
        taskCandidates.flatMap(candidate => candidate.artifactPaths),
      )),
    };
  }

  normalizeInlineResources(input: string, resources: string[], stripResource: (text: string) => string): InlineResourceNormalizationResult {
    return {
      normalizedGoal: stripResource(input) || input,
      resources,
    };
  }

  normalizeInlineResourcesFromInput(input: string, cwd = process.cwd()): InlineResourceNormalizationResult {
    const matches = extractInlineResourceMatches(input, cwd);
    return {
      normalizedGoal: stripInlineResourceMatches(input, matches) || input,
      resources: matches.map(match => match.resolvedPath),
    };
  }

  private extractKeywords(userPrompt: string): string[] {
    return userPrompt.split(/[\s，。？！、；：""''（）\[\]{}]+/)
      .filter(Boolean)
      .filter(token => token.length >= 2)
      .slice(0, 12);
  }
}
