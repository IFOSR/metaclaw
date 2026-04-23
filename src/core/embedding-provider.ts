export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}
