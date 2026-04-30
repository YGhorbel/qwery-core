import { Pool } from 'pg';
import { CREATE_SCHEMA_SQL, EMBEDDING_DIM } from './schema.js';
import type { TermIndexRecord, SearchResult } from './types.js';

export class VectorStore {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Detect existing table dimension and drop if it no longer matches.
      const dimResult = await client
        .query<{ col_type: string }>(
          `SELECT format_type(atttypid, atttypmod) AS col_type
           FROM pg_attribute
           WHERE attrelid = 'public.term_index'::regclass
             AND attname = 'embedding'
             AND attnum > 0`,
        )
        .catch(() => ({ rows: [] as { col_type: string }[] }));

      if (dimResult.rows.length > 0) {
        const match = dimResult.rows[0]!.col_type.match(/vector\((\d+)\)/);
        const existingDim = match ? Number(match[1]) : null;
        if (existingDim !== null && existingDim !== EMBEDDING_DIM) {
          await client.query('DROP TABLE IF EXISTS term_index CASCADE');
        }
      }

      await client.query(CREATE_SCHEMA_SQL);
    } finally {
      client.release();
    }
  }

  async upsertBatch(records: TermIndexRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const record of records) {
        await client.query(
          `INSERT INTO term_index (id, datasource_id, embedding, metadata)
           VALUES ($1, $2, $3::vector, $4)
           ON CONFLICT (id) DO UPDATE SET
             embedding  = EXCLUDED.embedding,
             metadata   = EXCLUDED.metadata,
             indexed_at = NOW()`,
          [
            record.id,
            record.datasource_id,
            JSON.stringify(record.embedding),
            JSON.stringify(record.metadata),
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async search(
    datasourceId: string,
    queryEmbedding: number[],
    limit = 5,
    threshold = 0.6,
  ): Promise<SearchResult[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{
        metadata: Record<string, unknown>;
        score: number;
      }>(
        `SELECT
           metadata,
           1 - (embedding <=> $1::vector) AS score
         FROM term_index
         WHERE datasource_id = $2
           AND 1 - (embedding <=> $1::vector) >= $3
         ORDER BY embedding <=> $1::vector
         LIMIT $4`,
        [JSON.stringify(queryEmbedding), datasourceId, threshold, limit],
      );
      return result.rows.map((row) => ({
        ...(row.metadata as Parameters<typeof Object.assign>[1]),
        score: row.score,
      })) as SearchResult[];
    } finally {
      client.release();
    }
  }

  async getById(id: string): Promise<TermIndexRecord | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{
        id: string;
        datasource_id: string;
        embedding: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT id, datasource_id, embedding::text, metadata
         FROM term_index WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        datasource_id: row.datasource_id,
        embedding: JSON.parse(row.embedding) as number[],
        metadata: row.metadata as TermIndexRecord['metadata'],
      };
    } finally {
      client.release();
    }
  }

  async updateSynonyms(id: string, synonyms: string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE term_index
         SET metadata = metadata || $1::jsonb, indexed_at = NOW()
         WHERE id = $2`,
        [JSON.stringify({ synonyms }), id],
      );
    } finally {
      client.release();
    }
  }

  async deleteByDatasource(datasourceId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('DELETE FROM term_index WHERE datasource_id = $1', [
        datasourceId,
      ]);
    } finally {
      client.release();
    }
  }

  /** BM25-style full-text search on label, field_id, description. */
  async sparseSearch(
    datasourceId: string,
    keywords: string[],
    limit = 10,
  ): Promise<Array<SearchResult & { rank: number }>> {
    if (keywords.length === 0) return [];
    const query = keywords.join(' ');
    const client = await this.pool.connect();
    try {
      const result = await client.query<{
        metadata: Record<string, unknown>;
        rank: number;
      }>(
        `SELECT
           metadata,
           ts_rank(
             to_tsvector('english',
               coalesce(metadata->>'label', '') || ' ' ||
               coalesce(metadata->>'field_id', '') || ' ' ||
               coalesce(metadata->>'description', '')
             ),
             plainto_tsquery('english', $3)
           ) AS rank
         FROM term_index
         WHERE datasource_id = $1
           AND to_tsvector('english',
                 coalesce(metadata->>'label', '') || ' ' ||
                 coalesce(metadata->>'field_id', '') || ' ' ||
                 coalesce(metadata->>'description', '')
               ) @@ plainto_tsquery('english', $3)
         ORDER BY rank DESC
         LIMIT $2`,
        [datasourceId, limit, query],
      );
      return result.rows.map((row) => ({
        ...(row.metadata as Parameters<typeof Object.assign>[1]),
        score: row.rank,
        rank: row.rank,
      })) as Array<SearchResult & { rank: number }>;
    } finally {
      client.release();
    }
  }

  /**
   * Hybrid search: dense cosine + sparse BM25 merged via Reciprocal Rank Fusion.
   * Falls back to dense-only when keywords array is empty.
   */
  async hybridSearch(
    datasourceId: string,
    queryEmbedding: number[],
    keywords: string[],
    limit = 5,
    threshold = 0.6,
  ): Promise<SearchResult[]> {
    const [denseResults, sparseResults] = await Promise.all([
      this.search(datasourceId, queryEmbedding, limit * 2, threshold),
      keywords.length > 0
        ? this.sparseSearch(datasourceId, keywords, limit * 2)
        : Promise.resolve([] as Array<SearchResult & { rank: number }>),
    ]);

    if (sparseResults.length === 0) return denseResults.slice(0, limit);

    const K = 60;
    const rrfScores = new Map<string, { result: SearchResult; score: number }>();

    const addRRF = (results: SearchResult[]) => {
      results.forEach((r, i) => {
        const id = (r as SearchResult & { field_id?: string }).field_id ?? JSON.stringify(r);
        const rrfScore = 1 / (K + i + 1);
        const existing = rrfScores.get(id);
        if (existing) {
          existing.score += rrfScore;
        } else {
          rrfScores.set(id, { result: r, score: rrfScore });
        }
      });
    };

    addRRF(denseResults);
    addRRF(sparseResults);

    return [...rrfScores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({ ...entry.result, score: entry.score }));
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
