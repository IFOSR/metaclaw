import { ExecutorRouter, type ExecutorProfile, type ExecutorRiskLevel } from '../core/executor-router.js';
import { seedDefaultExecutorProfiles } from '../core/executor-registry-seeder.js';
import { ExecutorProfileRepo } from '../storage/executor-profile-repo.js';
import { ExecutorRouteEventRepo } from '../storage/executor-route-event-repo.js';
import { generateInteractionId } from '../utils/id.js';
import type { CommandHandler } from './router.js';

function parseListArg(args: string[], flag: string): string[] {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : '';
  return value ? value.split(',').map(item => item.trim()).filter(Boolean) : [];
}

function parseScalarArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function formatProfile(profile: ExecutorProfile): string {
  const intents = Object.entries(profile.intentAffinity ?? {})
    .map(([intent, score]) => `${intent}:${score}`)
    .join(',');
  return `  ${profile.name} domains=${profile.domains.join(',')} capabilities=${profile.capabilities.join(',')} intents=${intents || '-'} risk=${profile.riskLevel} success=${profile.historicalSuccess}`;
}

export const executorCommand: CommandHandler = {
  name: 'executor',
  aliases: [],
  description: 'Executor 管理：/executor [profiles|profile upsert|route|route-feedback]',
  async execute(args, context) {
    const action = args[0] ?? 'profiles';
    const profileRepo = new ExecutorProfileRepo(context.db);
    seedDefaultExecutorProfiles(profileRepo, {
      defaultExecutorName: context.executor.name,
    });

    if (action === 'profile' && args[1] === 'upsert') {
      const name = args[2];
      if (!name) {
        return { type: 'text', content: '用法: /executor profile upsert <name> [--domains a,b] [--capabilities a,b]' };
      }
      const risk = (parseScalarArg(args, '--risk') ?? 'medium') as ExecutorRiskLevel;
      profileRepo.upsert({
        name,
        domains: parseListArg(args, '--domains'),
        capabilities: parseListArg(args, '--capabilities'),
        inputTypes: parseListArg(args, '--inputs'),
        outputTypes: parseListArg(args, '--outputs'),
        strengths: parseListArg(args, '--strengths'),
        weaknesses: parseListArg(args, '--weaknesses'),
        primaryUseCases: parseListArg(args, '--primary-use-cases'),
        avoidUseCases: parseListArg(args, '--avoid-use-cases'),
        intentAffinity: {},
        riskLevel: risk,
        availability: 'available',
        historicalSuccess: Number.parseFloat(parseScalarArg(args, '--success') ?? '0.5'),
      });
      return { type: 'text', content: `已更新 Executor Profile：${name}` };
    }

    if (action === 'profiles') {
      const profiles = profileRepo.findAll();
      if (profiles.length === 0) {
        return { type: 'text', content: '暂无 Executor Profiles' };
      }
      return { type: 'text', content: `Executor Profiles：\n${profiles.map(formatProfile).join('\n')}` };
    }

    if (action === 'route') {
      const userInput = args.slice(1).join(' ');
      if (!userInput) {
        return { type: 'text', content: '用法: /executor route <任务描述>' };
      }
      const profiles = profileRepo.findAll();
      const defaultExecutorName = context.executor.name;
      const decision = new ExecutorRouter([
        ...profiles,
        ...(profiles.some(profile => profile.name === defaultExecutorName)
          ? []
          : [{
            name: defaultExecutorName,
            domains: ['software'],
            capabilities: ['coding'],
            inputTypes: ['text'],
            outputTypes: ['code'],
            strengths: [],
            weaknesses: [],
            primaryUseCases: [],
            avoidUseCases: [],
            intentAffinity: { repo_execution: 1 },
            riskLevel: 'medium' as const,
            availability: 'available' as const,
            historicalSuccess: 0.5,
          }]),
      ]).route({ userInput, defaultExecutorName });
      new ExecutorRouteEventRepo(context.db).insert({
        id: `route_${generateInteractionId()}`,
        taskId: null,
        userInput,
        selectedExecutor: decision.selectedExecutor,
        action: decision.action,
        candidates: decision.candidates,
        primaryIntent: decision.primaryIntent,
        matchedBoundary: decision.matchedBoundary,
        rejected: decision.rejected,
        reason: decision.reason,
        confirmedByUser: false,
        result: null,
        createdAt: new Date().toISOString(),
      });
      return {
        type: 'text',
        content: [
          `Route Decision：${decision.selectedExecutor}`,
          `action=${decision.action} confidence=${decision.confidence.toFixed(2)}`,
          `intent=${decision.primaryIntent}`,
          `boundary=${decision.matchedBoundary.join(',') || '-'}`,
          `reason=${decision.reason}`,
        ].join('\n'),
      };
    }

    if (action === 'route-feedback') {
      const events = new ExecutorRouteEventRepo(context.db).listRecent();
      if (events.length === 0) {
        return { type: 'text', content: '暂无 Executor Route Feedback' };
      }
      return {
        type: 'text',
        content: `Executor Route Feedback：\n${events.map(event =>
          `  #${event.id} ${event.selectedExecutor} ${event.action} ${event.primaryIntent} ${event.userInput}`
        ).join('\n')}`,
      };
    }

    return { type: 'text', content: `未知 executor 操作: ${action}` };
  },
};
