import { Pool } from 'pg';
import { Embedder } from './embedder.js';
import {
  CREATE_ERROR_FIX_SQL,
  type StoredErrorFix,
  type ErrorFixRef,
} from './error-fix-schema.js';

export class ErrorFixStore {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(CREATE_ERROR_FIX_SQL);
    } finally {
      client.release();
    }
  }

  async store(fix: StoredErrorFix): Promise<void> {
    const embedder = new Embedder();
    const embText = `${fix.error_class}: ${fix.failed_sql.slice(0, 200)} | error: ${fix.evidence.slice(0, 100)}`;
    const embedding = await embedder.embedDocument(embText);

    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO error_fix_pairs (
          id, datasource_id, question, question_emb,
          failed_sql, error_class, evidence, edit_plan, corrected_sql
        ) VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO NOTHING`,
        [
          fix.id,
          fix.datasource_id,
          fix.question,
          JSON.stringify(embedding),
          fix.failed_sql,
          fix.error_class,
          fix.evidence,
          fix.edit_plan,
          fix.corrected_sql,
        ],
      );
    } finally {
      client.release();
    }
  }

  async findSimilar(
    failedSql: string,
    datasourceId: string,
    errorClass: string,
    limit = 2,
    threshold = 0.70,
  ): Promise<ErrorFixRef[]> {
    const embedder = new Embedder();
    const embText = `${errorClass}: ${failedSql.slice(0, 200)}`;
    const embedding = await embedder.embedQuery(embText);

    const client = await this.pool.connect();
    try {
      const query = `SELECT failed_sql, edit_plan, corrected_sql
         FROM error_fix_pairs
         WHERE datasource_id = $1
           AND error_class = $2
           AND 1 - (question_emb <=> $3::vector) >= $4
         ORDER BY question_emb <=> $3::vector
         LIMIT $5`;
      const args = [datasourceId, errorClass, JSON.stringify(embedding), threshold, limit];
      let result = await client.query<{
        failed_sql: string;
        edit_plan: string;
        corrected_sql: string;
      }>(query, args);

      // Retry with lower threshold if no matches found
      if (result.rows.length === 0 && threshold > 0.55) {
        result = await client.query<{
          failed_sql: string;
          edit_plan: string;
          corrected_sql: string;
        }>(query, [datasourceId, errorClass, JSON.stringify(embedding), 0.55, limit]);
      }

      return result.rows.map((row) => ({
        failedSql: row.failed_sql,
        editPlan: row.edit_plan,
        correctedSql: row.corrected_sql,
      }));
    } finally {
      client.release();
    }
  }

  async countByErrorClass(
    datasourceId: string,
    errorClass: string,
    days = 30,
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM error_fix_pairs
         WHERE datasource_id = $1
           AND error_class = $2
           AND created_at > NOW() - ($3 || ' days')::INTERVAL`,
        [datasourceId, errorClass, String(days)],
      );
      return parseInt(result.rows[0]?.count ?? '0', 10);
    } finally {
      client.release();
    }
  }

  async getRecentByErrorClass(
    datasourceId: string,
    errorClass: string,
    limit = 10,
  ): Promise<Array<{ evidence: string; edit_plan: string }>> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ evidence: string; edit_plan: string }>(
        `SELECT evidence, edit_plan FROM error_fix_pairs
         WHERE datasource_id = $1 AND error_class = $2
         ORDER BY created_at DESC LIMIT $3`,
        [datasourceId, errorClass, limit],
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
