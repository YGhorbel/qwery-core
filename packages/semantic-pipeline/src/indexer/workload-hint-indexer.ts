import { createHash } from 'node:crypto';
import type { VectorStore } from '@qwery/vector-store';
import type { Embedder } from '@qwery/vector-store';
import {
  extractJoinPatterns,
  extractFilterPatterns,
  generateHintText,
} from './workload-hint-generator.js';

export class WorkloadHintIndexer {
  constructor(
    private readonly vectorStore: VectorStore,
    private readonly embedder: Embedder,
  ) {}

  async indexHints(
    datasourceId: string,
    sqlStatements: string[],
  ): Promise<void> {
    if (sqlStatements.length < 20) return;

    const joinPatterns = extractJoinPatterns(sqlStatements);
    const filterPatterns = extractFilterPatterns(sqlStatements);
    const hints = [...joinPatterns, ...filterPatterns].map(generateHintText);

    if (hints.length === 0) return;

    const records = await Promise.all(
      hints.map(async (text) => {
        const hash = createHash('sha1').update(text).digest('hex').slice(0, 12);
        const id = `${datasourceId}::hint::${hash}`;
        const embedding = await this.embedder.embedDocument(text);
        return {
          id,
          datasource_id: datasourceId,
          embedding,
          metadata: {
            field_id: id,
            label: text.slice(0, 80),
            type: 'workload_hint' as const,
            table: '',
            sql: '',
            description: text,
            synonyms: [],
          },
        };
      }),
    );

    await this.vectorStore.upsertBatch(records);
    console.info(`[workload-hints] indexed ${records.length} hints for datasource ${datasourceId}`);
  }
}
