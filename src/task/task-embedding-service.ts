import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from '../core/embedding-provider.js';
import type { TaskMemoryKind } from '../core/types.js';
import type { TaskMemoryEmbeddingRecord } from '../storage/task-memory-embedding-repo.js';

export interface TaskMemoryDocument {
  taskId: string;
  memoryKind: TaskMemoryKind;
  sourceId: string;
  text: string;
}

interface TaskMemoryEmbeddingRepoLike {
  findBySource(
    taskId: string,
    memoryKind: TaskMemoryKind,
    sourceId: string,
  ): TaskMemoryEmbeddingRecord | null;
  upsert(record: TaskMemoryEmbeddingRecord): void;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function buildEmbeddingId(document: TaskMemoryDocument): string {
  const sourceKey = document.sourceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `taskemb_${document.taskId}_${document.memoryKind}_${sourceKey}`;
}

export class TaskEmbeddingService {
  constructor(
    private provider: EmbeddingProvider,
    private repo: TaskMemoryEmbeddingRepoLike,
  ) {}

  async embedTaskDocument(document: TaskMemoryDocument): Promise<boolean> {
    const [vector] = await this.provider.embed([document.text]);
    if (!vector || vector.length === 0) {
      return false;
    }

    const now = new Date().toISOString();
    const existing = this.repo.findBySource(document.taskId, document.memoryKind, document.sourceId);
    this.repo.upsert({
      id: existing?.id ?? buildEmbeddingId(document),
      taskId: document.taskId,
      memoryKind: document.memoryKind,
      sourceId: document.sourceId,
      provider: this.provider.provider,
      model: this.provider.model,
      dimension: vector.length,
      vector,
      contentHash: hashContent(document.text),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    return true;
  }
}
