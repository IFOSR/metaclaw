import type Database from 'better-sqlite3';
import type { ExecutorProfile } from '../core/executor-router.js';
import { seedDefaultExecutorProfiles } from './executor-registry-seeder.js';
import { ExecutorProfileRepo } from '../storage/executor-profile-repo.js';

export interface ExecutorProfileServiceDeps {
  db: Database.Database;
  defaultExecutorName: string;
  availableCommands?: Set<string>;
}

export class ExecutorProfileService {
  private readonly repo: ExecutorProfileRepo;

  constructor(private readonly deps: ExecutorProfileServiceDeps) {
    this.repo = new ExecutorProfileRepo(deps.db);
  }

  seedDefaults(): void {
    seedDefaultExecutorProfiles(this.repo, {
      defaultExecutorName: this.deps.defaultExecutorName,
      availableCommands: this.deps.availableCommands,
    });
  }

  listProfiles(options: { seedDefaults?: boolean } = { seedDefaults: true }): ExecutorProfile[] {
    if (options.seedDefaults ?? true) {
      this.seedDefaults();
    }
    return this.repo.findAll();
  }

  findByName(name: string): ExecutorProfile | null {
    return this.repo.findByName(name);
  }

  upsert(profile: ExecutorProfile): void {
    this.repo.upsert(profile);
  }
}
