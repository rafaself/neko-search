/** Generates normalized dense vectors for documents and search queries. */
export interface EmbeddingGenerator {
  embedDocuments(documents: string[]): Promise<Float32Array[]>;

  embedQuery(query: string): Promise<Float32Array>;
}
