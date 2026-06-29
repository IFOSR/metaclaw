import type { ExecutorAvailability, ExecutorProfile, ExecutorRiskLevel, TaskRouteIntent } from '../core/executor-router.js';
import { ExecutionPlanningService } from '../core/execution-planning-service.js';
import { buildRouteDecisionFromPolicy } from '../routing/execution-policy-planner.js';
import type { IntentDecisionV2, IntentExecutionMode } from '../core/intent-orchestrator.js';
import type { CapabilityClass } from '../core/capability-class.js';
import type { Task } from '../core/types.js';
import { seedDefaultExecutorProfiles } from '../executor/executor-registry-seeder.js';
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

function parseRuntimeArgs(value?: string): string[] {
  if (!value) return [];
  return value.split(/\s+/).map(item => item.trim()).filter(Boolean);
}

function buildProfileFromArgs(
  name: string,
  args: string[],
  existing?: ExecutorProfile | null,
  availability: ExecutorAvailability = 'available',
): ExecutorProfile {
  const risk = (parseScalarArg(args, '--risk') ?? existing?.riskLevel ?? 'medium') as ExecutorRiskLevel;
  return {
    name,
    domains: parseListArg(args, '--domains').length > 0 ? parseListArg(args, '--domains') : existing?.domains ?? [],
    capabilities: parseListArg(args, '--capabilities').length > 0 ? parseListArg(args, '--capabilities') : existing?.capabilities ?? [],
    inputTypes: parseListArg(args, '--inputs').length > 0 ? parseListArg(args, '--inputs') : existing?.inputTypes ?? ['text'],
    outputTypes: parseListArg(args, '--outputs').length > 0 ? parseListArg(args, '--outputs') : existing?.outputTypes ?? ['markdown'],
    strengths: parseListArg(args, '--strengths').length > 0 ? parseListArg(args, '--strengths') : existing?.strengths ?? [],
    weaknesses: parseListArg(args, '--weaknesses').length > 0 ? parseListArg(args, '--weaknesses') : existing?.weaknesses ?? [],
    primaryUseCases: parseListArg(args, '--primary-use-cases').length > 0
      ? parseListArg(args, '--primary-use-cases')
      : existing?.primaryUseCases ?? [],
    avoidUseCases: parseListArg(args, '--avoid-use-cases').length > 0
      ? parseListArg(args, '--avoid-use-cases')
      : existing?.avoidUseCases ?? [],
    intentAffinity: existing?.intentAffinity ?? {},
    riskLevel: risk,
    availability,
    historicalSuccess: Number.parseFloat(parseScalarArg(args, '--success') ?? String(existing?.historicalSuccess ?? 0.5)),
    runtimeCommand: parseScalarArg(args, '--command') ?? existing?.runtimeCommand ?? null,
    runtimeArgs: parseScalarArg(args, '--args') ? parseRuntimeArgs(parseScalarArg(args, '--args')) : existing?.runtimeArgs ?? [],
    runtimeCheckCommand: parseScalarArg(args, '--check') ?? existing?.runtimeCheckCommand ?? null,
    projectUrl: parseScalarArg(args, '--project-url') ?? existing?.projectUrl ?? null,
  };
}

function formatProfile(profile: ExecutorProfile): string {
  const intents = Object.entries(profile.intentAffinity ?? {})
    .map(([intent, score]) => `${intent}:${score}`)
    .join(',');
  const runtime = profile.runtimeCommand
    ? `runtime=${profile.runtimeCommand} ${(profile.runtimeArgs ?? []).join(' ')}`.trim()
    : 'runtime=-';
  return `  ${profile.name} status=${profile.availability} domains=${profile.domains.join(',') || '-'} capabilities=${profile.capabilities.join(',') || '-'} intents=${intents || '-'} risk=${profile.riskLevel} success=${profile.historicalSuccess} ${runtime}`;
}

function createPreviewTask(userInput: string): Task {
  const now = new Date().toISOString();
  return {
    id: `route_preview_${generateInteractionId()}`,
    title: userInput.slice(0, 50) || 'Executor route preview',
    goal: userInput,
    status: 'created',
    summary: '',
    snapshots: [],
    resources: [],
    artifacts: [],
    dependencies: [],
    prioritySignals: {
      dueAt: null,
      isReady: true,
      progressRatio: 0,
      blocksOthers: false,
      idleHours: 0,
    },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function inferPreviewPrimaryIntent(userInput: string): TaskRouteIntent {
  const normalized = userInput.toLowerCase();
  if (/实现|修复|修改|代码|测试|bug|patch|repo|仓库/i.test(normalized)) {
    return 'repo_execution';
  }
  if (/deepseek|算法|推理|边界条件|数学|技术分析/i.test(normalized)) {
    return 'technical_reasoning';
  }
  if (/长期记忆|多工具|自动化|消息网关|通知客户|发送给客户|memory|mcp/i.test(normalized)) {
    return 'memory_agent_ops';
  }
  if (/调研|研究|报告|市场|竞品|资料|research/i.test(normalized)) {
    return 'research_workflow';
  }
  return 'general';
}

function inferPreviewExecutionMode(userInput: string): IntentExecutionMode {
  return /多个 agent|多执行器|并行|分别做|多视角|subagent/i.test(userInput)
    ? 'multi_executor'
    : 'single_executor';
}

function capabilityClassFromPreviewIntent(intent: TaskRouteIntent): CapabilityClass {
  if (intent === 'repo_execution') return 'code_edit';
  if (intent === 'research_workflow') return 'research';
  if (intent === 'memory_agent_ops') return 'memory_ops';
  if (intent === 'conversation_or_control') return 'conversation';
  return 'general';
}

function buildPreviewIntentDecision(userInput: string, profiles: ExecutorProfile[], defaultExecutorName: string): IntentDecisionV2 {
  const primaryIntent = inferPreviewPrimaryIntent(userInput);
  const matchingProfiles = profiles
    .filter(profile => profile.availability === 'available')
    .filter(profile => {
      const searchable = [
        profile.name,
        ...profile.domains,
        ...profile.capabilities,
        ...(profile.primaryUseCases ?? []),
      ].join('\n');
      if (primaryIntent === 'general') {
        return /合同|条款|法务|legal|contract|风险矩阵/i.test(userInput)
          && /legal|contract|合同|法务|risk_matrix/i.test(searchable);
      }
      return true;
    });
  const selectedExecutor = matchingProfiles.find(profile => profile.name !== defaultExecutorName)?.name
    ?? matchingProfiles[0]?.name
    ?? defaultExecutorName;

  return {
    interactionType: 'executor_dispatch',
    confidence: 0.72,
    reason: 'executor route preview uses ExecutionPlanningService from a conservative command intent decision',
    clarificationQuestion: null,
    risk: {
      level: /合同|条款|法务|legal|contract|发送给客户|通知客户/i.test(userInput) ? 'high' : 'medium',
      requiresConfirmation: /合同|条款|法务|legal|contract|发送给客户|通知客户/i.test(userInput),
      reasons: [],
    },
    task: {
      binding: 'none',
      taskId: null,
      control: 'none',
      scope: null,
    },
    execution: {
      mode: inferPreviewExecutionMode(userInput),
      complexity: 'simple',
      selectedExecutor,
      candidateExecutors: matchingProfiles.map(profile => profile.name),
      requiresVerification: primaryIntent === 'repo_execution',
      canModifyFiles: primaryIntent === 'repo_execution',
      requiresExternalGateway: primaryIntent === 'memory_agent_ops',
      capabilityClass: capabilityClassFromPreviewIntent(primaryIntent),
      primaryIntent,
      matchedBoundary: primaryIntent === 'general' ? [] : [primaryIntent],
    },
    hints: [],
  };
}

export const executorCommand: CommandHandler = {
  name: 'executor',
  aliases: ['executors'],
  description: 'Executor 管理：/executor [list|register|unregister|route|route-feedback]',
  async execute(args, context) {
    const action = args[0] ?? 'list';
    const profileRepo = new ExecutorProfileRepo(context.db);
    seedDefaultExecutorProfiles(profileRepo, {
      defaultExecutorName: context.executor.name,
    });

    if (action === 'register' || (action === 'profile' && args[1] === 'upsert')) {
      const name = action === 'register' ? args[1] : args[2];
      const optionArgs = action === 'register' ? args.slice(2) : args.slice(3);
      if (!name) {
        return {
          type: 'text',
          content: [
            '进入 Executor 注册向导：请直接输入 /executor register wizard',
            '',
            '一次性注册用法:',
            '/executor register <name> --command <cmd> --args "exec --prompt {prompt}" --check "<cmd> --version" [--project-url <url>] [--domains a,b] [--capabilities a,b]',
          ].join('\n'),
        };
      }
      if (name === 'wizard') {
        return {
          type: 'text',
          content: 'Executor 注册向导已启动。请按提示回答；输入 cancel 可取消。',
          data: { executorRegisterWizard: true },
        };
      }
      profileRepo.upsert(buildProfileFromArgs(name, optionArgs, profileRepo.findByName(name), 'available'));
      return {
        type: 'text',
        content: action === 'register'
          ? `已注册 Executor：${name}`
          : `已更新 Executor Profile：${name}`,
      };
    }

    if (action === 'unregister') {
      const name = args[1];
      if (!name) {
        return { type: 'text', content: '用法: /executor unregister <name>' };
      }
      const existing = profileRepo.findByName(name);
      if (!existing) {
        return { type: 'text', content: `Executor 未注册：${name}` };
      }
      profileRepo.upsert({
        ...existing,
        availability: 'unavailable',
      });
      return { type: 'text', content: `已反注册 Executor：${name}` };
    }

    if (action === 'list' || action === 'profiles') {
      const profiles = profileRepo.findAll();
      if (profiles.length === 0) {
        return { type: 'text', content: '暂无已注册 Executor' };
      }
      return {
        type: 'text',
        content: [
          `已注册 Executors（默认：${context.executor.name}）：`,
          ...profiles.map(formatProfile),
          '',
          '命令：/executor register wizard',
          '命令：/executor register <name> --command <cmd> --args "exec --prompt {prompt}" --check "<cmd> --version" [--domains a,b] [--capabilities a,b]',
          '命令：/executor unregister <name>',
        ].join('\n'),
      };
    }

    if (action === 'route') {
      const userInput = args.slice(1).join(' ');
      if (!userInput) {
        return { type: 'text', content: '用法: /executor route <任务描述>' };
      }
      const profiles = profileRepo.findAll();
      const defaultExecutorName = context.executor.name;
      const routeProfiles = [
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
      ];
      const policy = new ExecutionPlanningService().plan({
        task: createPreviewTask(userInput),
        userPrompt: userInput,
        taskExecutionPlan: {
          mode: 'reuse-existing',
          executionTaskId: 'route-preview',
          contextTaskId: 'route-preview',
          transitions: [],
        },
        intentDecision: buildPreviewIntentDecision(userInput, routeProfiles, defaultExecutorName),
        executorProfiles: routeProfiles,
        defaultExecutorName,
        resources: [],
      });
      const decision = buildRouteDecisionFromPolicy(policy);
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
