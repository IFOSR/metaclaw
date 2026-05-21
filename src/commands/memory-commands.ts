import { RecallReviewPolicyRepo } from '../storage/recall-review-policy-repo.js';
import { MemoryAuditEventRepo, type MemoryAuditEventRecord } from '../storage/memory-audit-event-repo.js';
import { MemoryVaultExporter } from '../core/memory-vault-exporter.js';
import type { PreferenceScope } from '../core/types.js';
import type { CommandHandler, CommandContext, CommandResult } from './router.js';
import { generateInteractionId } from '../utils/id.js';

const VALID_SCOPES = new Set<PreferenceScope>(['global', 'project', 'contact', 'task-local']);

interface ParsedMemoryArgs {
  scope?: PreferenceScope;
  type?: string;
  subject?: string;
  rest: string[];
}

function parseMemoryArgs(args: string[]): ParsedMemoryArgs {
  const parsed: ParsedMemoryArgs = { rest: [] };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === '--scope') {
      const scope = args[index + 1] as PreferenceScope | undefined;
      if (scope && VALID_SCOPES.has(scope)) {
        parsed.scope = scope;
        index += 1;
        continue;
      }
    }

    if (token === '--type') {
      const type = args[index + 1];
      if (type) {
        parsed.type = type;
        index += 1;
        continue;
      }
    }

    if (token === '--subject') {
      const subject = args[index + 1];
      if (subject) {
        parsed.subject = subject;
        index += 1;
        continue;
      }
    }

    parsed.rest.push(token);
  }

  return parsed;
}

function formatPreferenceLine(preference: {
  id: string;
  scope: string;
  subject: string | null;
  content: string;
}): string {
  const subjectText = preference.subject ? ` (${preference.subject})` : '';
  return `  #${preference.id} [${preference.scope}]${subjectText} ${preference.content}`;
}

function formatReviewPolicyLine(policy: {
  id: string;
  policyType: string;
  scope: string | null;
  subject: string | null;
  proposalType: string | null;
  autoApply: boolean;
}): string {
  const fragments = [
    policy.policyType,
    policy.scope ? `scope=${policy.scope}` : null,
    policy.subject ? `subject=${policy.subject}` : null,
    policy.proposalType ? `proposal=${policy.proposalType}` : null,
    `autoApply=${policy.autoApply ? 'yes' : 'no'}`,
  ].filter(Boolean);
  return `  #${policy.id} ${fragments.join(' | ')}`;
}

function formatAuditEventLine(
  event: MemoryAuditEventRecord,
  preferenceContent?: string,
): string {
  const taskText = event.taskId ? ` task=${event.taskId}` : '';
  const scoreText = event.score === null ? '' : ` score=${event.score.toFixed(2)}`;
  const contentText = preferenceContent ? ` ${preferenceContent}` : '';
  return `  #${event.id} ${event.action}${taskText} memory=${event.memoryId}${scoreText} source=${event.judgeSource}${contentText}`;
}

function parseDirArg(args: string[]): string | undefined {
  const index = args.indexOf('--dir');
  return index >= 0 ? args[index + 1] : undefined;
}

export const memoryCommand: CommandHandler = {
  name: 'memory',
  aliases: [],
  description: '偏好管理：/memory [search|add|edit|delete|candidates|confirm|reject|stats]',
  async execute(args, context) {
    const action = args[0];

    if (!action) {
      // 显示所有活跃偏好
      const prefs = context.memoryEngine.list({ status: 'confirmed' });
      if (prefs.length === 0) {
        return { type: 'text', content: '暂无已确认偏好' };
      }

      const lines = prefs.map(formatPreferenceLine);
      return { type: 'text', content: `已确认偏好：\n${lines.join('\n')}` };
    }

    switch (action) {
      case 'search': {
        const keyword = args[1];
        if (!keyword) {
          return { type: 'text', content: '用法: /memory search <关键词>' };
        }
        const results = context.memoryEngine['prefRepo'].searchByKeyword(keyword);
        if (results.length === 0) {
          return { type: 'text', content: `未找到包含 "${keyword}" 的偏好` };
        }
        const lines = results.map(formatPreferenceLine);
        return { type: 'text', content: `搜索结果：\n${lines.join('\n')}` };
      }

      case 'add': {
        const parsed = parseMemoryArgs(args.slice(1));
        const content = parsed.rest.join(' ');
        if (!content) {
          return { type: 'text', content: '用法: /memory add [--scope <global|project|contact|task-local>] [--type <type>] [--subject <subject>] <内容>' };
        }
        const pref = context.memoryEngine.addManual({
          content,
          scope: parsed.scope ?? 'global',
          type: parsed.type ?? 'domain',
          subject: parsed.subject,
        });
        return { type: 'text', content: `已添加偏好 #${pref.id}` };
      }

      case 'edit': {
        const prefId = args[1];
        const parsed = parseMemoryArgs(args.slice(2));
        const content = parsed.rest.join(' ');
        if (!prefId || (!content && parsed.scope === undefined && parsed.type === undefined && parsed.subject === undefined)) {
          return { type: 'text', content: '用法: /memory edit <id> [--scope <global|project|contact|task-local>] [--type <type>] [--subject <subject>] <新内容>' };
        }

        const updated = context.memoryEngine.update(prefId, {
          ...(content ? { content } : {}),
          ...(parsed.scope ? { scope: parsed.scope } : {}),
          ...(parsed.type ? { type: parsed.type } : {}),
          ...(parsed.subject ? { subject: parsed.subject } : {}),
        });
        return { type: 'text', content: `已更新偏好 #${updated.id}: ${updated.content}` };
      }

      case 'delete': {
        const prefId = args[1];
        if (!prefId) {
          return { type: 'text', content: '用法: /memory delete <id>' };
        }
        context.memoryEngine.delete(prefId);
        return { type: 'text', content: `已删除偏好 #${prefId}` };
      }

      case 'candidates': {
        const candidates = context.memoryEngine.getCandidates();
        if (candidates.length === 0) {
          return { type: 'text', content: '暂无待确认偏好' };
        }
        const lines = candidates.map(c => `  #${c.id} (${c.occurrenceCount}次) ${c.pattern}`);
        return { type: 'text', content: `待确认偏好：\n${lines.join('\n')}` };
      }

      case 'confirm': {
        const obsId = args[1];
        if (!obsId) {
          return { type: 'text', content: '用法: /memory confirm <observation_id> [--scope <global|project|contact|task-local>] [--subject <subject>]' };
        }
        try {
          const parsed = parseMemoryArgs(args.slice(2));
          const pref = context.memoryEngine.confirm(obsId, parsed.scope ?? 'global', parsed.subject);
          return { type: 'text', content: `已确认偏好 #${pref.id}: ${pref.content}` };
        } catch (error) {
          return { type: 'text', content: `确认失败: ${(error as Error).message}` };
        }
      }

      case 'reject': {
        const obsId = args[1];
        if (!obsId) {
          return { type: 'text', content: '用法: /memory reject <observation_id>' };
        }
        context.memoryEngine.reject(obsId);
        return { type: 'text', content: `已拒绝候选偏好 #${obsId}` };
      }

      case 'stats': {
        const all = context.memoryEngine.list();
        const confirmed = all.filter(p => p.status === 'confirmed').length;
        const candidates = context.memoryEngine.getCandidates().length;
        return {
          type: 'text',
          content: `偏好统计：\n  已确认: ${confirmed}\n  待确认: ${candidates}\n  总计: ${all.length}`,
        };
      }

      case 'recent': {
        const repo = new MemoryAuditEventRepo(context.db);
        const events = repo.findRecent();
        if (events.length === 0) {
          return { type: 'text', content: '暂无最近记忆事件' };
        }
        return {
          type: 'text',
          content: `最近记忆事件：\n${events.map(event => formatAuditEventLine(
            event,
            context.memoryEngine.list().find(pref => pref.id === event.memoryId)?.content,
          )).join('\n')}`,
        };
      }

      case 'auto-captured': {
        const repo = new MemoryAuditEventRepo(context.db);
        const events = repo.findByAction('auto_capture');
        if (events.length === 0) {
          return { type: 'text', content: '暂无自动写入记忆' };
        }
        return {
          type: 'text',
          content: `自动写入记忆：\n${events.map(event => formatAuditEventLine(
            event,
            context.memoryEngine.list().find(pref => pref.id === event.memoryId)?.content,
          )).join('\n')}`,
        };
      }

      case 'applied': {
        const repo = new MemoryAuditEventRepo(context.db);
        const taskId = args[1];
        const events = repo.findApplied(taskId);
        if (events.length === 0) {
          return { type: 'text', content: taskId ? `任务 ${taskId} 暂无已自动采用记忆` : '暂无已自动采用记忆' };
        }
        const title = taskId ? `已自动采用记忆（${taskId}）：` : '已自动采用记忆：';
        return {
          type: 'text',
          content: `${title}\n${events.map(event => formatAuditEventLine(
            event,
            context.memoryEngine.list().find(pref => pref.id === event.memoryId)?.content,
          )).join('\n')}`,
        };
      }

      case 'undo': {
        const prefId = args[1];
        if (!prefId) {
          return { type: 'text', content: '用法: /memory undo <memoryId>' };
        }
        const existing = context.memoryEngine.list().find(pref => pref.id === prefId);
        if (!existing) {
          return { type: 'text', content: `记忆不存在或已撤销: ${prefId}` };
        }
        context.memoryEngine.delete(prefId);
        new MemoryAuditEventRepo(context.db).insert({
          id: `memory_audit_${generateInteractionId()}`,
          taskId: null,
          memoryId: prefId,
          action: 'undo',
          score: null,
          reason: '用户通过 /memory undo 撤销记忆',
          judgeSource: 'rule',
          evidence: [],
          createdAt: new Date().toISOString(),
        });
        return { type: 'text', content: `已撤销记忆 #${prefId}: ${existing.content}` };
      }

      case 'explain': {
        const prefId = args[1];
        if (!prefId) {
          return { type: 'text', content: '用法: /memory explain <memoryId>' };
        }
        const preference = context.memoryEngine.list().find(pref => pref.id === prefId);
        if (!preference) {
          return { type: 'text', content: `记忆不存在: ${prefId}` };
        }
        const events = new MemoryAuditEventRepo(context.db).findByMemoryId(prefId);
        return {
          type: 'text',
          content: [
            `记忆说明 #${preference.id}`,
            `scope=${preference.scope} subject=${preference.subject ?? 'none'} confidence=${preference.confidence}`,
            preference.content,
            '',
            'Evidence / Timeline:',
            ...events.map(event => formatAuditEventLine(event)),
            ...events.map(event => `  reason=${event.reason}`),
          ].join('\n'),
        };
      }

      case 'evidence': {
        const prefId = args[1];
        if (!prefId) {
          return { type: 'text', content: '用法: /memory evidence <memoryId>' };
        }
        const events = new MemoryAuditEventRepo(context.db).findByMemoryId(prefId);
        if (events.length === 0) {
          return { type: 'text', content: `记忆 #${prefId} 暂无 evidence` };
        }
        return {
          type: 'text',
          content: `Evidence for ${prefId}:\n${events.map(event => [
            formatAuditEventLine(event),
            `    reason=${event.reason}`,
            `    evidence=${JSON.stringify(event.evidence)}`,
          ].join('\n')).join('\n')}`,
        };
      }

      case 'timeline': {
        const events = new MemoryAuditEventRepo(context.db).findRecent(50);
        if (events.length === 0) {
          return { type: 'text', content: '暂无记忆时间线' };
        }
        return {
          type: 'text',
          content: `记忆时间线：\n${events.map(event => `${event.createdAt} ${formatAuditEventLine(event).trim()}`).join('\n')}`,
        };
      }

      case 'relations': {
        const prefId = args[1];
        if (!prefId) {
          return { type: 'text', content: '用法: /memory relations <memoryId>' };
        }
        const events = new MemoryAuditEventRepo(context.db).findByMemoryId(prefId);
        if (events.length === 0) {
          return { type: 'text', content: `记忆 #${prefId} 暂无 relations` };
        }
        return {
          type: 'text',
          content: `Relations for ${prefId}:\n${events.map(event =>
            `  memory=${event.memoryId} task=${event.taskId ?? 'none'} evidence=${event.id} action=${event.action}`
          ).join('\n')}`,
        };
      }

      case 'vault': {
        const subAction = args[1];
        const vaultDir = parseDirArg(args.slice(2));
        const exporter = new MemoryVaultExporter(context.db, context.memoryEngine);
        if (subAction === 'export') {
          const result = exporter.export({ vaultDir });
          return {
            type: 'text',
            content: `Vault 导出完成：${result.vaultDir}\npreferences=${result.preferenceCount}\nevidence=${result.evidenceCount}`,
          };
        }
        if (subAction === 'status') {
          const result = exporter.status({ vaultDir });
          return {
            type: 'text',
            content: `Vault 状态：${result.vaultDir}\npreferences=${result.preferenceCount}\nevidence=${result.evidenceCount}`,
          };
        }
        return { type: 'text', content: '用法: /memory vault [export|status] [--dir <path>]' };
      }

      case 'review-policy': {
        const repo = new RecallReviewPolicyRepo(context.db);

        if (args[1] === 'revoke') {
          const policyId = args[2];
          if (!policyId) {
            return { type: 'text', content: '用法: /memory review-policy revoke <id>' };
          }
          repo.delete(policyId);
          return { type: 'text', content: `已撤销 recall review policy #${policyId}` };
        }

        const policies = repo.findAll();
        if (policies.length === 0) {
          return { type: 'text', content: '暂无 recall review policy' };
        }

        return {
          type: 'text',
          content: `Recall Review Policies:\n${policies.map(formatReviewPolicyLine).join('\n')}`,
        };
      }

      default:
        return { type: 'text', content: `未知操作: ${action}` };
    }
  },
};
