import type Database from 'better-sqlite3';
import type { AgentClass, AgentClassKind } from '../core/types.js';
import { seedDefaultAgentClasses, seedDefaultWorkUnits } from './agent-class-seeder.js';
import { AgentClassRepo } from '../storage/agent-class-repo.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';

export interface AgentClassServiceDeps {
  db: Database.Database;
  defaultExecutorName: string;
  availableCommands?: Set<string>;
}

export class AgentClassService {
  private readonly agentClassRepo: AgentClassRepo;
  private readonly workUnitRepo: WorkUnitRepo;

  constructor(private readonly deps: AgentClassServiceDeps) {
    this.agentClassRepo = new AgentClassRepo(deps.db);
    this.workUnitRepo = new WorkUnitRepo(deps.db);
  }

  seedDefaults(): void {
    seedDefaultAgentClasses(this.agentClassRepo, {
      defaultExecutorName: this.deps.defaultExecutorName,
      availableCommands: this.deps.availableCommands,
    });
    seedDefaultWorkUnits(this.workUnitRepo, {
      executorAgentClassName: this.deps.defaultExecutorName,
    });
  }

  listAgentClasses(options: { seedDefaults?: boolean } = { seedDefaults: true }): AgentClass[] {
    if (options.seedDefaults ?? true) {
      this.seedDefaults();
    }
    return this.agentClassRepo.findAll();
  }

  listByKind(kind: AgentClassKind): AgentClass[] {
    this.seedDefaults();
    return this.agentClassRepo.findByKind(kind);
  }

  findByName(name: string): AgentClass | null {
    return this.agentClassRepo.findByName(name);
  }

  upsert(agentClass: AgentClass): void {
    this.agentClassRepo.upsert(agentClass);
  }
}
