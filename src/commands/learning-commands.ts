import { LearningCandidateRepo, type LearningCandidateRecord } from '../storage/learning-candidate-repo.js';
import { ExecutorSkillInstallEventRepo, type ExecutorSkillInstallStatus } from '../storage/executor-skill-install-event-repo.js';
import { TaskMemoryCardRepo, type TaskMemoryCardOutcome } from '../storage/task-memory-card-repo.js';
import { SkillEffectSummaryRepo, type SkillEffectSummaryRecord } from '../storage/skill-effect-summary-repo.js';
import { SkillUsageEventRepo } from '../storage/skill-usage-event-repo.js';
import { ReflectionEventRepo } from '../storage/reflection-event-repo.js';
import { ReflectionEngine } from '../learning/reflection-engine.js';
import { PromotionGate } from '../learning/promotion-gate.js';
import { buildExecutorSkillPackage } from '../executor/skill-package-builder.js';
import { SkillGovernanceEngine, assessSkillGovernance, type SkillGovernanceAction } from '../learning/skill-governance-engine.js';
import { LearningWeeklyReviewBuilder } from '../learning/learning-weekly-review-builder.js';
import { generateInteractionId } from '../utils/id.js';
import type { CommandHandler } from './router.js';

function formatCandidateLine(candidate: ReturnType<LearningCandidateRepo['listPending']>[number]): string {
  return `  #${candidate.id} [${candidate.kind}/${candidate.safetyStatus}] ${candidate.title}`;
}

function createInstallAuditId(): string {
  return `install_${generateInteractionId().replace(/^int_/, '')}`;
}

function createTaskMemoryCardId(): string {
  return `tmc_${generateInteractionId().replace(/^int_/, '')}`;
}

function extractList(content: string, label: string): string[] {
  const line = content.split('\n').find(item => item.startsWith(`${label}：`) || item.startsWith(`${label}:`));
  if (!line) return [];
  return line
    .replace(new RegExp(`^${label}[：:]\\s*`), '')
    .split(/[;,，、]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function extractField(content: string, label: string, fallback = ''): string {
  const line = content.split('\n').find(item => item.startsWith(`${label}：`) || item.startsWith(`${label}:`));
  return line ? line.replace(new RegExp(`^${label}[：:]\\s*`), '').trim() : fallback;
}

function normalizeOutcome(value: string): TaskMemoryCardOutcome {
  if (value === 'failed' || value === 'partial' || value === 'blocked') return value;
  return 'success';
}

function buildTaskMemoryCard(candidate: LearningCandidateRecord) {
  const now = new Date().toISOString();
  return {
    id: createTaskMemoryCardId(),
    taskId: candidate.sourceTaskId ?? candidate.id,
    title: candidate.title,
    goal: extractField(candidate.content, '目标', candidate.title),
    summary: extractField(candidate.content, '摘要', candidate.content.slice(0, 500)),
    keyDecisions: extractList(candidate.content, '关键决策'),
    changedFiles: extractList(candidate.content, '修改文件'),
    verificationCommands: extractList(candidate.content, '验证命令'),
    pitfalls: extractList(candidate.content, '坑点'),
    artifacts: extractList(candidate.content, '产物'),
    outcome: normalizeOutcome(extractField(candidate.content, '结果', 'success')),
    sourceCandidateId: candidate.id,
    createdAt: now,
    updatedAt: now,
  };
}

function formatSkillSummary(summary: SkillEffectSummaryRecord): string {
  const version = summary.skillVersion ?? 'unversioned';
  const successRate = summary.usedCount === 0 ? 0 : Math.round((summary.successCount / summary.usedCount) * 100);
  const governance = assessSkillGovernance(summary);
  const risk = governance.riskLabel === 'high'
    ? ` [高风险/${governance.action === 'disable' ? '建议停用' : '建议废弃'}]`
    : governance.riskLabel === 'watch'
      ? ' [观察]'
      : '';
  return `  ${summary.skillName}@${version} executor=${summary.executorName} 使用 ${summary.usedCount} 次，成功率 ${successRate}%，失败 ${summary.failureCount}，patch ${summary.patchCandidateCount}${risk}`;
}

function parseGovernanceTarget(candidate: LearningCandidateRecord): { skillName: string; skillVersion: string | null } {
  const asset = candidate.promotedAssetId ?? '';
  const match = asset.match(/^[^/]+\/(.+)@(.+)$/);
  if (match) {
    return { skillName: match[1], skillVersion: match[2] === 'unversioned' ? null : match[2] };
  }
  const skill = extractField(candidate.content, 'skill', candidate.title.replace(/^.*Skill[：:]/, '').trim());
  const version = extractField(candidate.content, 'version', 'unversioned');
  return { skillName: skill, skillVersion: version === 'unversioned' ? null : version };
}

function governanceActionForCandidate(candidate: LearningCandidateRecord): Exclude<SkillGovernanceAction, 'none'> | null {
  if (candidate.kind === 'skill_disable') return 'disable';
  if (candidate.kind === 'skill_deprecation') return 'deprecate';
  return null;
}

function formatTaskMemoryCardLine(card: ReturnType<TaskMemoryCardRepo['listRecent']>[number]): string {
  return `  #${card.id} [${card.outcome}] ${card.title} (${card.taskId})`;
}

function formatPatchCandidateLine(candidate: LearningCandidateRecord): string {
  return `  #${candidate.id} [${candidate.status}/${candidate.safetyStatus}] ${candidate.title}`;
}

function writeInstallAudit(
  repo: ExecutorSkillInstallEventRepo,
  input: {
    candidateId: string;
    packageId: string | null;
    executorName: string;
    action: 'install' | 'update' | 'disable' | 'deprecate';
    status: ExecutorSkillInstallStatus;
    message: string;
  },
): void {
  repo.create({
    id: createInstallAuditId(),
    candidateId: input.candidateId,
    packageId: input.packageId,
    executorName: input.executorName,
    action: input.action,
    status: input.status,
    message: input.message,
    createdAt: new Date().toISOString(),
  });
}

export const learningCommand: CommandHandler = {
  name: 'learning',
  aliases: [],
  description: '学习候选审核：/learning [candidates|approve|reject] ...',
  async execute(args, context) {
    const action = args[0] ?? 'candidates';
    const repo = new LearningCandidateRepo(context.db);

    switch (action) {
      case 'skill-feedback': {
        const usageEvents = new SkillUsageEventRepo(context.db).listRecent(50);
        const reflectionRepo = new ReflectionEventRepo(context.db);
        const engine = new ReflectionEngine();
        let created = 0;

        for (const event of usageEvents) {
          if (!['skill_failed', 'skill_suggested_patch'].includes(event.eventType)) {
            continue;
          }

          const reflection = engine.reflectOnSkillUsage(event);
          if (reflectionRepo.findById(reflection.event.id)) {
            continue;
          }

          const existingForSource = context.db.prepare(
            'SELECT id FROM reflection_events WHERE source_type = ? AND source_id = ? LIMIT 1'
          ).get('executor_skill_usage', event.id) as { id: string } | undefined;
          if (existingForSource) {
            continue;
          }

          reflectionRepo.insert(reflection.event);
          if (reflection.candidate) {
            repo.insert(reflection.candidate);
            created += 1;
          }
        }

        return { type: 'text', content: `已生成 Skill Runtime Feedback：${created} 个候选` };
      }

      case 'patch': {
        const subAction = args[1] ?? 'candidates';
        if (subAction === 'candidates') {
          const candidates = repo.listPending().filter(candidate => candidate.kind === 'skill_patch');
          if (candidates.length === 0) {
            return { type: 'text', content: '暂无 Skill Patch Candidates' };
          }
          return {
            type: 'text',
            content: `Skill Patch Candidates：\n${candidates.map(formatPatchCandidateLine).join('\n')}`,
          };
        }

        if (subAction === 'approve') {
          const id = args[2];
          if (!id) {
            return { type: 'text', content: '用法: /learning patch approve <id>' };
          }
          const candidate = repo.findById(id);
          if (!candidate || candidate.kind !== 'skill_patch') {
            return { type: 'text', content: `未找到 Skill Patch Candidate #${id}` };
          }
          repo.updateReview(id, {
            status: 'approved',
            reviewNote: args.slice(3).join(' ') || null,
            promotedAssetId: candidate.promotedAssetId,
            updatedAt: new Date().toISOString(),
          });
          return { type: 'text', content: `已批准 Skill Patch Candidate #${id}` };
        }

        if (subAction === 'promote') {
          const id = args[2];
          if (!id) {
            return { type: 'text', content: '用法: /learning patch promote <id>' };
          }
          return learningCommand.execute(['promote', id], context);
        }

        return { type: 'text', content: `未知 patch 操作: ${subAction}` };
      }

      case 'candidates': {
        const candidates = repo.listPending();
        if (candidates.length === 0) {
          return { type: 'text', content: '暂无待审核学习候选' };
        }

        return {
          type: 'text',
          content: `待审核学习候选：\n${candidates.map(formatCandidateLine).join('\n')}`,
        };
      }

      case 'approve': {
        const id = args[1];
        if (!id) {
          return { type: 'text', content: '用法: /learning approve <candidate_id> [备注]' };
        }
        const candidate = repo.findById(id);
        if (!candidate) {
          return { type: 'text', content: `未找到学习候选 #${id}` };
        }
        repo.updateReview(id, {
          status: 'approved',
          reviewNote: args.slice(2).join(' ') || null,
          updatedAt: new Date().toISOString(),
        });
        return { type: 'text', content: `已批准学习候选 #${id}` };
      }

      case 'reject': {
        const id = args[1];
        if (!id) {
          return { type: 'text', content: '用法: /learning reject <candidate_id> [原因]' };
        }
        const candidate = repo.findById(id);
        if (!candidate) {
          return { type: 'text', content: `未找到学习候选 #${id}` };
        }
        repo.updateReview(id, {
          status: 'rejected',
          reviewNote: args.slice(2).join(' ') || null,
          updatedAt: new Date().toISOString(),
        });
        return { type: 'text', content: `已拒绝学习候选 #${id}` };
      }

      case 'promote': {
        const id = args[1];
        if (!id) {
          return { type: 'text', content: '用法: /learning promote <candidate_id>' };
        }

        const candidate = repo.findById(id);
        if (!candidate) {
          return { type: 'text', content: `未找到学习候选 #${id}` };
        }

        const gate = new PromotionGate().evaluate({
          kind: candidate.kind,
          status: candidate.status,
          safetyStatus: candidate.safetyStatus,
        });
        if (gate.decision !== 'promote') {
          if (candidate.kind === 'skill' || candidate.kind === 'skill_patch') {
            writeInstallAudit(new ExecutorSkillInstallEventRepo(context.db), {
              candidateId: candidate.id,
              packageId: null,
              executorName: context.executor.name,
              action: candidate.kind === 'skill_patch' ? 'update' : 'install',
              status: 'blocked',
              message: gate.reason,
            });
          }
          return { type: 'text', content: `学习候选 #${id} 不能 promotion：${gate.reason}` };
        }

        if (candidate.kind === 'task_memory_card') {
          const cardRepo = new TaskMemoryCardRepo(context.db);
          const card = buildTaskMemoryCard(candidate);
          cardRepo.insert(card);
          repo.updateReview(candidate.id, {
            status: 'promoted',
            reviewNote: candidate.reviewNote,
            promotedAssetId: card.id,
            updatedAt: new Date().toISOString(),
          });
          return { type: 'text', content: `已沉淀任务记忆卡：${card.title}` };
        }

        const governanceAction = governanceActionForCandidate(candidate);
        if (governanceAction) {
          const auditRepo = new ExecutorSkillInstallEventRepo(context.db);
          const target = parseGovernanceTarget(candidate);
          const operation = governanceAction === 'disable' ? context.executor.disableSkill : context.executor.deprecateSkill;
          const actionLabel = governanceAction === 'disable' ? '停用' : '废弃';
          const auditAction = governanceAction === 'disable' ? 'disable' : 'deprecate';
          if (!operation) {
            writeInstallAudit(auditRepo, {
              candidateId: candidate.id,
              packageId: candidate.promotedAssetId,
              executorName: context.executor.name,
              action: auditAction,
              status: 'unsupported',
              message: `当前 executor 不支持 skill ${governanceAction}`,
            });
            return { type: 'text', content: `当前 executor ${context.executor.name} 不支持 Skill ${actionLabel}；已记录 audit。` };
          }

          const governanceResult = await operation.call(context.executor, target);
          const status: ExecutorSkillInstallStatus = governanceResult.ok ? 'success' : 'failed';
          writeInstallAudit(auditRepo, {
            candidateId: candidate.id,
            packageId: candidate.promotedAssetId,
            executorName: governanceResult.executorName || context.executor.name,
            action: auditAction,
            status,
            message: governanceResult.message,
          });

          if (!governanceResult.ok) {
            return { type: 'text', content: `学习候选 #${id} 治理下发失败：${governanceResult.message}` };
          }

          repo.updateReview(candidate.id, {
            status: 'promoted',
            reviewNote: candidate.reviewNote,
            promotedAssetId: candidate.promotedAssetId,
            updatedAt: new Date().toISOString(),
          });
          return { type: 'text', content: `已下发并${actionLabel} Skill：${target.skillName}@${target.skillVersion ?? 'unversioned'}` };
        }

        const auditRepo = new ExecutorSkillInstallEventRepo(context.db);
        let pkg;
        try {
          pkg = buildExecutorSkillPackage(candidate);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          writeInstallAudit(auditRepo, {
            candidateId: candidate.id,
            packageId: null,
            executorName: context.executor.name,
            action: candidate.kind === 'skill_patch' ? 'update' : 'install',
            status: 'blocked',
            message,
          });
          return { type: 'text', content: `学习候选 #${id} 不能 promotion：${message}` };
        }

        const installAction = candidate.kind === 'skill_patch' ? 'update' : 'install';
        const unsupportedMessage = installAction === 'update'
          ? '当前 executor 不支持 skill update'
          : '当前 executor 不支持 skill install';
        const unsupportedContent = installAction === 'update'
          ? `当前 executor ${context.executor.name} 不支持 Skill 更新；已记录 audit。`
          : `当前 executor ${context.executor.name} 不支持 Skill 安装；已记录 audit。`;
        const operation = installAction === 'update' ? context.executor.updateSkill : context.executor.installSkill;

        if (!operation) {
          writeInstallAudit(auditRepo, {
            candidateId: candidate.id,
            packageId: pkg.id,
            executorName: context.executor.name,
            action: installAction,
            status: 'unsupported',
            message: unsupportedMessage,
          });
          return { type: 'text', content: unsupportedContent };
        }

        const installResult = await operation.call(context.executor, pkg);
        const status: ExecutorSkillInstallStatus = installResult.ok ? 'success' : 'failed';
        writeInstallAudit(auditRepo, {
          candidateId: candidate.id,
          packageId: pkg.id,
          executorName: installResult.executorName || context.executor.name,
          action: installAction,
          status,
          message: installResult.message,
        });

        if (!installResult.ok) {
          return { type: 'text', content: `学习候选 #${id} 下发失败：${installResult.message}` };
        }

        repo.updateReview(candidate.id, {
          status: 'promoted',
          reviewNote: candidate.reviewNote,
          promotedAssetId: installResult.installedSkillName ?? pkg.name,
          updatedAt: new Date().toISOString(),
        });

        const verb = installAction === 'update' ? '更新' : '安装';
        return { type: 'text', content: `已下发并${verb} Skill：${installResult.installedSkillName ?? pkg.name}@${installResult.installedVersion ?? pkg.version}` };
      }

      case 'cards': {
        const cards = new TaskMemoryCardRepo(context.db).listRecent(10);
        if (cards.length === 0) {
          return { type: 'text', content: '暂无任务记忆卡' };
        }
        return { type: 'text', content: `任务记忆卡：\n${cards.map(formatTaskMemoryCardLine).join('\n')}` };
      }

      case 'skills': {
        const summaries = new SkillEffectSummaryRepo(context.db).listTop(10);
        if (summaries.length === 0) {
          return { type: 'text', content: '暂无 Skill Effect Summary' };
        }
        return { type: 'text', content: `Skill Effect Summary：\n${summaries.map(formatSkillSummary).join('\n')}` };
      }

      case 'weekly': {
        const review = new LearningWeeklyReviewBuilder(context.db).build();
        return {
          type: 'text',
          content: review.markdown,
          data: {
            weeklyReview: {
              pendingCandidateCount: review.pendingCandidateCount,
              taskMemoryCardCount: review.taskMemoryCardCount,
              governanceRecommendationCount: review.governanceRecommendationCount,
            },
          },
        };
      }

      case 'summary': {
        const pendingCount = repo.listPending().length;
        const cards = new TaskMemoryCardRepo(context.db).listRecent(5);
        const summaries = new SkillEffectSummaryRepo(context.db).listTop(5);
        const governanceCandidates = new SkillGovernanceEngine().review(summaries);
        const lines = [
          '学习资产概览：',
          `待审核候选 ${pendingCount}`,
          `任务记忆卡 ${cards.length}`,
          `Skill Summary ${summaries.length}`,
          `建议治理的 Skill ${governanceCandidates.length}`,
        ];
        if (cards.length > 0) {
          lines.push('最近任务记忆卡：', ...cards.map(formatTaskMemoryCardLine));
        }
        if (summaries.length > 0) {
          lines.push('Skill 效果：', ...summaries.map(formatSkillSummary));
        }
        return { type: 'text', content: lines.join('\n') };
      }

      default:
        return { type: 'text', content: `未知操作: ${action}` };
    }
  },
};
