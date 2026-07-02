import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { AgentClassRepo } from '../../src/storage/agent-class-repo.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import { WorkUnitClaimService } from '../../src/execution/work-unit-claim-service.js';
import type { AgentClass, WorkUnit } from '../../src/core/types.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function agentClass(): AgentClass {
  return {
    name: 'codex-cli',
    kind: 'executor',
    domains: ['software'],
    capabilities: ['coding'],
    inputTypes: ['text'],
    outputTypes: ['markdown'],
    strengths: [],
    weaknesses: [],
    primaryUseCases: [],
    avoidUseCases: [],
    intentAffinity: {},
    riskLevel: 'medium',
    availability: 'available',
    historicalSuccess: 0.8,
    harness: 'cli',
    model: null,
    skills: [],
    mcpServers: [],
    plugins: [],
    runtimeCommand: null,
    runtimeArgs: [],
    runtimeCheckCommand: null,
    projectUrl: null,
  };
}

function workUnit(): WorkUnit {
  return {
    id: 'executor-1',
    agentClassName: 'codex-cli',
    agentClassKind: 'executor',
    state: 'idle',
    claimedTaskId: null,
    claimedSubtaskId: null,
    heartbeatAt: null,
    leaseExpiresAt: null,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  };
}

describe('WorkUnitClaimService', () => {
  it('claims and releases an idle executor work unit', () => {
    const db = createDb();
    new AgentClassRepo(db).upsert(agentClass());
    const repo = new WorkUnitRepo(db);
    repo.upsert(workUnit());

    const claim = new WorkUnitClaimService(repo).claim({
      taskId: 'task_1',
      subtask: {
        id: 'subtask_1',
        requiredAgentClassKind: 'executor',
        candidateAgentClasses: ['codex-cli'],
      },
    });

    expect(claim?.workUnit.id).toBe('executor-1');
    expect(repo.findById('executor-1')).toMatchObject({
      state: 'claimed',
      claimedTaskId: 'task_1',
      claimedSubtaskId: 'subtask_1',
    });

    claim?.markRunning();
    expect(repo.findById('executor-1')?.state).toBe('running');

    claim?.release();
    expect(repo.findById('executor-1')).toMatchObject({
      state: 'idle',
      claimedTaskId: null,
      claimedSubtaskId: null,
    });
    expect(repo.listEvents('executor-1').map(event => event.eventType)).toEqual([
      'claimed',
      'running',
      'released',
    ]);
  });

  it('marks expired claimed work units as heartbeat_lost', () => {
    const db = createDb();
    new AgentClassRepo(db).upsert(agentClass());
    const repo = new WorkUnitRepo(db);
    repo.upsert({
      ...workUnit(),
      state: 'running',
      claimedTaskId: 'task_1',
      claimedSubtaskId: 'subtask_1',
      leaseExpiresAt: '2026-07-02T00:00:00.000Z',
    });

    const lost = new WorkUnitClaimService(repo).sweepExpired(new Date('2026-07-02T00:01:00.000Z'));

    expect(lost).toHaveLength(1);
    expect(repo.findById('executor-1')?.state).toBe('heartbeat_lost');
  });
});
