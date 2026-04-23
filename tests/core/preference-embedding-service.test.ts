import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryEngine } from '../../src/core/memory-engine.js';
import { PreferenceEmbeddingService } from '../../src/core/preference-embedding-service.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('PreferenceEmbeddingService', () => {
  it('stores vectors for confirmed preferences only', async () => {
    const provider = {
      provider: 'test-provider',
      model: 'test-model',
      embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    };
    const repo = {
      findByPreferenceId: vi.fn().mockReturnValue(null),
      upsert: vi.fn(),
    };

    const service = new PreferenceEmbeddingService(provider as any, repo as any);

    const stored = await service.embedPreference({
      id: 'pref_1',
      content: '给张总的内容使用正式语气',
      status: 'confirmed',
    } as any);
    const skipped = await service.embedPreference({
      id: 'pref_2',
      content: '这条还没确认',
      status: 'candidate',
    } as any);

    expect(stored).toBe(true);
    expect(skipped).toBe(false);
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(repo.upsert).toHaveBeenCalledTimes(1);
  });

  it('keeps rule-based recall working when embedding refresh is unavailable', async () => {
    const db = createTestDb();
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    const embeddingService = {
      embedPreference: vi.fn().mockRejectedValue(new Error('embedding unavailable')),
    };
    const engine = new MemoryEngine(prefRepo, obsRepo, embeddingService as any);

    engine.addManual({
      content: '输出用 Markdown 格式',
      scope: 'global',
      type: 'style',
    });

    const results = engine.recall({ keywords: ['Markdown'] });
    await Promise.resolve();

    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('Markdown');
    expect(embeddingService.embedPreference).toHaveBeenCalledTimes(1);
  });

  it('enqueues embedding refresh on confirm, manual add, and update', async () => {
    const db = createTestDb();
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    const embeddingService = {
      embedPreference: vi.fn().mockResolvedValue(true),
    };
    const engine = new MemoryEngine(prefRepo, obsRepo, embeddingService as any);

    const manual = engine.addManual({
      content: '默认输出简洁',
      scope: 'global',
      type: 'style',
    });

    engine.observe('给张总使用正式语气', 'task_1');
    engine.observe('给张总使用正式语气', 'task_2');
    const thirdObservation = engine.observe('给张总使用正式语气', 'task_3');
    const confirmed = engine.confirm(thirdObservation.observation.id, 'contact', '张总');
    engine.update(manual.id, { content: '默认输出简洁且结论优先' });

    await Promise.resolve();

    expect(embeddingService.embedPreference).toHaveBeenCalledTimes(3);
    expect(embeddingService.embedPreference).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: manual.id }),
    );
    expect(embeddingService.embedPreference).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: confirmed.id }),
    );
    expect(embeddingService.embedPreference).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ id: manual.id, content: '默认输出简洁且结论优先' }),
    );
  });
});
