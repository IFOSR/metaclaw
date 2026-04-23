import { createHash } from 'node:crypto';
import type { Preference } from './types.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import type { PreferenceEmbeddingRecord } from '../storage/preference-embedding-repo.js';

interface PreferenceEmbeddingRepoLike {
  findByPreferenceId(preferenceId: string): PreferenceEmbeddingRecord | null;
  upsert(record: PreferenceEmbeddingRecord): void;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function buildEmbeddingId(preferenceId: string): string {
  return `prefemb_${preferenceId}`;
}

export class PreferenceEmbeddingService {
  constructor(
    private provider: EmbeddingProvider,
    private repo: PreferenceEmbeddingRepoLike,
  ) {}

  async embedPreference(preference: Pick<Preference, 'id' | 'content' | 'status'>): Promise<boolean> {
    if (preference.status !== 'confirmed') {
      return false;
    }

    const [vector] = await this.provider.embed([preference.content]);
    if (!vector || vector.length === 0) {
      return false;
    }

    const now = new Date().toISOString();
    const existing = this.repo.findByPreferenceId(preference.id);
    this.repo.upsert({
      id: existing?.id ?? buildEmbeddingId(preference.id),
      preferenceId: preference.id,
      provider: this.provider.provider,
      model: this.provider.model,
      dimension: vector.length,
      vector,
      contentHash: hashContent(preference.content),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    return true;
  }
}
