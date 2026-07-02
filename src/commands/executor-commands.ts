import type { AgentClass, AgentClassAvailability, AgentClassRiskLevel, Task } from '../core/types.js';
import type { IntentDecisionV2, IntentExecutionMode } from '../core/intent-orchestrator.js';
import type { TaskRouteIntent } from '../core/executor-router.js';
import { capabilityClassFromTaskRouteIntent } from '../core/executor-router.js';
import { ensureExecutorWorkUnit, seedDefaultAgentClasses, seedDefaultWorkUnits } from '../executor/agent-class-seeder.js';
import { PlannerRoutingSkill } from '../planner/planner-routing-skill.js';
import { AgentClassRepo } from '../storage/agent-class-repo.js';
import { TaskEventRepo } from '../storage/task-event-repo.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
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

function buildAgentClassFromArgs(
  name: string,
  args: string[],
  existing?: AgentClass | null,
  availability: AgentClassAvailability = 'available',
): AgentClass {
  const risk = (parseScalarArg(args, '--risk') ?? existing?.riskLevel ?? 'medium') as AgentClassRiskLevel;
  return {
    name,
    kind: 'executor',
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
    harness: existing?.harness ?? 'cli',
    model: existing?.model ?? null,
    skills: existing?.skills ?? [],
    mcpServers: existing?.mcpServers ?? [],
    plugins: existing?.plugins ?? [],
    runtimeCommand: parseScalarArg(args, '--command') ?? existing?.runtimeCommand ?? null,
    runtimeArgs: parseScalarArg(args, '--args') ? parseRuntimeArgs(parseScalarArg(args, '--args')) : existing?.runtimeArgs ?? [],
    runtimeCheckCommand: parseScalarArg(args, '--check') ?? existing?.runtimeCheckCommand ?? null,
    projectUrl: parseScalarArg(args, '--project-url') ?? existing?.projectUrl ?? null,
  };
}

function formatAgentClass(agentClass: AgentClass): string {
  const intents = Object.entries(agentClass.intentAffinity ?? {})
    .map(([intent, score]) => `${intent}:${score}`)
    .join(',');
  const runtime = agentClass.runtimeCommand
    ? `runtime=${agentClass.runtimeCommand} ${(agentClass.runtimeArgs ?? []).join(' ')}`.trim()
    : 'runtime=-';
  return `  ${agentClass.name} kind=${agentClass.kind} status=${agentClass.availability} domains=${agentClass.domains.join(',') || '-'} capabilities=${agentClass.capabilities.join(',') || '-'} intents=${intents || '-'} risk=${agentClass.riskLevel} success=${agentClass.historicalSuccess} ${runtime}`;
}

function createPreviewTask(userInput: string): Task {
  const now = new Date().toISOString();
  return {
    id: `route_preview_${generateInteractionId()}`,
    title: userInput.slice(0, 50) || 'Planner route preview',
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

function buildPreviewIntentDecision(userInput: string, agentClasses: AgentClass[], defaultExecutorName: string): IntentDecisionV2 {
  const primaryIntent = inferPreviewPrimaryIntent(userInput);
  const matching = agentClasses
    .filter(agentClass => agentClass.kind === 'executor' && agentClass.availability === 'available')
    .filter(agentClass => {
      const searchable = [
        agentClass.name,
        ...agentClass.domains,
        ...agentClass.capabilities,
        ...(agentClass.primaryUseCases ?? []),
      ].join('\n');
      if (primaryIntent === 'general') {
        return /合同|条款|法务|legal|contract|风险矩阵/i.test(userInput)
          && /legal|contract|合同|法务|risk_matrix/i.test(searchable);
      }
      return true;
    });
  const selectedExecutor = matching.find(agentClass => agentClass.name !== defaultExecutorName)?.name
    ?? matching[0]?.name
    ?? defaultExecutorName;

  return {
    interactionType: 'executor_dispatch',
    confidence: 0.72,
    reason: 'planner route preview uses PlannerRoutingSkill without claiming work units',
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
      candidateExecutors: matching.map(agentClass => agentClass.name),
      requiresVerification: primaryIntent === 'repo_execution',
      canModifyFiles: primaryIntent === 'repo_execution',
      requiresExternalGateway: primaryIntent === 'memory_agent_ops',
      capabilityClass: capabilityClassFromTaskRouteIntent(primaryIntent) ?? 'general',
      primaryIntent,
      matchedBoundary: primaryIntent === 'general' ? [] : [primaryIntent],
    },
    hints: [],
  };
}

export const executorCommand: CommandHandler = {
  name: 'executor',
  aliases: ['executors'],
  description: 'AgentClass/WorkUnit management: /executor [list|register|unregister|route|route-feedback]',
  async execute(args, context) {
    const action = args[0] ?? 'list';
    const agentClassRepo = new AgentClassRepo(context.db);
    const workUnitRepo = new WorkUnitRepo(context.db);
    seedDefaultAgentClasses(agentClassRepo, {
      defaultExecutorName: context.executor.name,
    });
    seedDefaultWorkUnits(workUnitRepo, { executorAgentClassName: context.executor.name });

    if (action === 'register' || (action === 'profile' && args[1] === 'upsert')) {
      const name = action === 'register' ? args[1] : args[2];
      const optionArgs = action === 'register' ? args.slice(2) : args.slice(3);
      if (!name) {
        return {
          type: 'text',
          content: [
            'Enter the AgentClass registration wizard with /executor register wizard',
            '',
            'One-line usage:',
            '/executor register <name> --command <cmd> --args "exec --prompt {prompt}" --check "<cmd> --version" [--project-url <url>] [--domains a,b] [--capabilities a,b]',
          ].join('\n'),
        };
      }
      if (name === 'wizard') {
        return {
          type: 'text',
          content: 'Executor AgentClass registration wizard started. Answer the prompts, or type cancel.',
          data: { executorRegisterWizard: true },
        };
      }
      agentClassRepo.upsert(buildAgentClassFromArgs(name, optionArgs, agentClassRepo.findByName(name), 'available'));
      ensureExecutorWorkUnit(workUnitRepo, name);
      return {
        type: 'text',
        content: action === 'register'
          ? `Registered Executor AgentClass: ${name}`
          : `Updated Executor AgentClass: ${name}`,
      };
    }

    if (action === 'unregister') {
      const name = args[1];
      if (!name) {
        return { type: 'text', content: 'Usage: /executor unregister <name>' };
      }
      const existing = agentClassRepo.findByName(name);
      if (!existing) {
        return { type: 'text', content: `Executor AgentClass is not registered: ${name}` };
      }
      agentClassRepo.upsert({ ...existing, availability: 'unavailable' });
      return { type: 'text', content: `Unregistered Executor AgentClass: ${name}` };
    }

    if (action === 'list' || action === 'profiles') {
      const agentClasses = agentClassRepo.findAll();
      if (agentClasses.length === 0) {
        return { type: 'text', content: 'No AgentClass records are registered.' };
      }
      const workUnits = workUnitRepo.findAll();
      return {
        type: 'text',
        content: [
          `Registered AgentClasses (default executor: ${context.executor.name}):`,
          ...agentClasses.map(formatAgentClass),
          '',
          `WorkUnits: ${workUnits.map(unit => `${unit.id}:${unit.agentClassName}:${unit.state}`).join(', ') || '-'}`,
          '',
          'Commands: /executor register wizard',
          'Commands: /executor register <name> --command <cmd> --args "exec --prompt {prompt}" --check "<cmd> --version" [--domains a,b] [--capabilities a,b]',
          'Commands: /executor unregister <name>',
        ].join('\n'),
      };
    }

    if (action === 'route') {
      const userInput = args.slice(1).join(' ');
      if (!userInput) {
        return { type: 'text', content: 'Usage: /executor route <task description>' };
      }
      const agentClasses = agentClassRepo.findAll();
      const plan = new PlannerRoutingSkill().plan({
        task: createPreviewTask(userInput),
        userPrompt: userInput,
        taskExecutionPlan: {
          mode: 'reuse-existing',
          executionTaskId: 'route-preview',
          contextTaskId: 'route-preview',
          transitions: [],
        },
        intentDecision: buildPreviewIntentDecision(userInput, agentClasses, context.executor.name),
        agentClasses,
        resources: [],
        recalledTaskIds: [],
      });
      const firstSubtask = plan.subtasks[0];
      return {
        type: 'text',
        content: [
          'Planner Route Preview',
          `subtasks=${plan.subtasks.length}`,
          `reason=${plan.reason}`,
          firstSubtask ? `first=${firstSubtask.title}` : 'first=-',
          firstSubtask ? `candidateAgentClasses=${firstSubtask.candidateAgentClasses.join(',') || '-'}` : 'candidateAgentClasses=-',
          firstSubtask ? `agentClassKind=${firstSubtask.requiredAgentClassKind}` : 'agentClassKind=-',
        ].join('\n'),
      };
    }

    if (action === 'route-feedback') {
      const events = new TaskEventRepo(context.db).listRecent();
      if (events.length === 0) {
        return { type: 'text', content: 'No planner task events recorded yet.' };
      }
      return {
        type: 'text',
        content: `Planner Task Events:\n${events.map(event =>
          `  #${event.id} ${event.eventType} task=${event.taskId} subtask=${event.subtaskId ?? '-'} ${event.message}`
        ).join('\n')}`,
      };
    }

    return { type: 'text', content: `Unknown executor operation: ${action}` };
  },
};
