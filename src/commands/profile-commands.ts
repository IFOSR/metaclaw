import { MemoryAuditEventRepo } from '../storage/memory-audit-event-repo.js';
import type { CommandHandler } from './router.js';

export const profileCommand: CommandHandler = {
  name: 'profile',
  aliases: [],
  description: '工作画像：/profile [user|project <name>|executor <name>]',
  async execute(args, context) {
    const action = args[0] ?? 'user';
    const preferences = context.memoryEngine.list({ status: 'confirmed' });

    if (action === 'user') {
      const events = new MemoryAuditEventRepo(context.db).findRecent(1000);
      return {
        type: 'text',
        content: [
          '用户工作画像',
          `长期记忆 ${preferences.length}`,
          `自动化事件 ${events.length}`,
          ...preferences.slice(0, 10).map(preference => `  - [${preference.scope}] ${preference.content}`),
        ].join('\n'),
      };
    }

    if (action === 'project') {
      const subject = args[1];
      if (!subject) {
        return { type: 'text', content: '用法: /profile project <name>' };
      }
      const projectPreferences = preferences.filter(preference =>
        preference.scope === 'project' && preference.subject === subject
      );
      return {
        type: 'text',
        content: [
          `项目画像：${subject}`,
          `长期记忆 ${projectPreferences.length}`,
          ...projectPreferences.map(preference => `  - ${preference.content}`),
        ].join('\n'),
      };
    }

    if (action === 'executor') {
      const executorName = args[1] ?? context.executor.name;
      const rows = context.db.prepare(`
        SELECT skill_name, skill_version, used_count, success_count, failure_count, patch_candidate_count
        FROM skill_effect_summaries
        WHERE executor_name = ?
        ORDER BY used_count DESC, updated_at DESC
        LIMIT 10
      `).all(executorName) as Array<{
        skill_name: string;
        skill_version: string | null;
        used_count: number;
        success_count: number;
        failure_count: number;
        patch_candidate_count: number;
      }>;

      return {
        type: 'text',
        content: [
          `Executor 画像：${executorName}`,
          `Skill Summary ${rows.length}`,
          ...rows.map(row => `  - ${row.skill_name}@${row.skill_version ?? 'unversioned'} used=${row.used_count} success=${row.success_count} failure=${row.failure_count} patch=${row.patch_candidate_count}`),
        ].join('\n'),
      };
    }

    return { type: 'text', content: `未知 profile 操作: ${action}` };
  },
};
