import { Pool } from 'pg';
import { Embedder } from './embedder.js';
import { CREATE_TRACES_SQL, type StoredQueryTrace } from './trace-schema.js';
import type { VectorStore } from './client.js';

// Minimal trace shape used by multi-path-runner (path 3)
export type QueryTraceRef = {
  question: string;
  sql_final: string;
};

export class TraceStore {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(CREATE_TRACES_SQL);
    } finally {
      client.release();
    }
  }

  async store(trace: StoredQueryTrace): Promise<void> {
    const embedder = new Embedder();
    const embedding = await embedder.embedQuery(trace.question);

    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO query_traces (
          id, datasource_id, question, question_emb,
          keywords, fields_used, sql_final, result_shape,
          intent, complexity, path_used, correction_applied, success
        ) VALUES (
          $1, $2, $3, $4::vector,
          $5, $6, $7, $8,
          $9, $10, $11, $12, $13
        ) ON CONFLICT (id) DO NOTHING`,
        [
          trace.id,
          trace.datasourceId,
          trace.question,
          JSON.stringify(embedding),
          trace.keywords,
          JSON.stringify(trace.fieldsUsed),
          trace.sqlFinal,
          JSON.stringify(trace.resultShape),
          trace.intent,
          trace.complexity,
          trace.pathUsed,
          trace.correctionApplied ? JSON.stringify(trace.correctionApplied) : null,
          trace.success,
        ],
      );
    } finally {
      client.release();
    }
  }

  async findSimilar(
    question: string,
    datasourceId: string,
    threshold = 0.85,
  ): Promise<QueryTraceRef | null> {
    const embedder = new Embedder();
    const embedding = await embedder.embedQuery(question);

    const client = await this.pool.connect();
    try {
      const result = await client.query<{ question: string; sql_final: string }>(
        `SELECT question, sql_final
         FROM query_traces
         WHERE datasource_id = $1
           AND success = true
           AND 1 - (question_emb <=> $2::vector) >= $3
         ORDER BY question_emb <=> $2::vector
         LIMIT 1`,
        [datasourceId, JSON.stringify(embedding), threshold],
      );
      return result.rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  async countRecent(datasourceId: string, days = 7): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM query_traces
         WHERE datasource_id = $1
           AND success = true
           AND created_at > NOW() - ($2 || ' days')::INTERVAL`,
        [datasourceId, String(days)],
      );
      return parseInt(result.rows[0]?.count ?? '0', 10);
    } finally {
      client.release();
    }
  }

  // Distillation: collect keywords from recent traces → update term_index synonyms
  async distill(datasourceId: string, vectorStore: VectorStore): Promise<void> {
    const client = await this.pool.connect();
    let rows: Array<{ keywords: string[]; fields_used: string }>;

    try {
      const result = await client.query<{
        keywords: string[];
        fields_used: string;
      }>(
        `SELECT keywords, fields_used FROM query_traces
         WHERE datasource_id = $1
           AND success = true
           AND created_at > NOW() - INTERVAL '7 days'
         ORDER BY created_at DESC
         LIMIT 50`,
        [datasourceId],
      );
      rows = result.rows;
    } finally {
      client.release();
    }

    if (rows.length < 10) return;

    const fieldKeywords = new Map<string, Set<string>>();
    for (const row of rows) {
      const fields = (
        typeof row.fields_used === 'string'
          ? JSON.parse(row.fields_used)
          : row.fields_used
      ) as Array<{ field_id: string }>;
      for (const field of fields) {
        if (!fieldKeywords.has(field.field_id)) {
          fieldKeywords.set(field.field_id, new Set());
        }
        for (const k of row.keywords) fieldKeywords.get(field.field_id)!.add(k);
      }
    }

    for (const [fieldId, keywords] of fieldKeywords) {
      const existing = await vectorStore.getById(`${datasourceId}::${fieldId}`);
      if (!existing) continue;

      const current: string[] = (existing.metadata.synonyms as string[]) ?? [];
      const merged = [...new Set([...current, ...keywords])]
        .filter((s) => s.length > 2)
        .slice(0, 20);

      if (merged.length > current.length) {
        await vectorStore.updateSynonyms(`${datasourceId}::${fieldId}`, merged);
      }
    }
  }

  async getRecentSQL(datasourceId: string, limit = 100): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ sql_final: string }>(
        `SELECT sql_final FROM query_traces
         WHERE datasource_id = $1
           AND success = true
           AND sql_final != ''
         ORDER BY created_at DESC
         LIMIT $2`,
        [datasourceId, limit],
      );
      return result.rows.map((r) => r.sql_final);
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
