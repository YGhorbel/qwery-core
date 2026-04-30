import { Pool } from 'pg';
import { CREATE_TRIBAL_SQL, type TribalRule } from './tribal-schema.js';

export class TribalStore {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(CREATE_TRIBAL_SQL);
    } finally {
      client.release();
    }
  }

  /**
   * Distill 3+ error-fix pairs into a generalized rule.
   * LLM call is made externally and injected as `ruleText`.
   */
  async upsertRule(
    datasourceId: string,
    errorClass: string,
    ruleText: string,
    appliesToTables: string[],
    sourcePairCount: number,
  ): Promise<void> {
    const id = `${datasourceId}::${errorClass}::${Buffer.from(ruleText).toString('base64').slice(0, 16)}`;
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO tribal_rules (id, datasource_id, rule_text, applies_to_tables, error_class, source_pair_count)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           rule_text         = EXCLUDED.rule_text,
           source_pair_count = EXCLUDED.source_pair_count,
           updated_at        = NOW()`,
        [id, datasourceId, ruleText, appliesToTables, errorClass, sourcePairCount],
      );
    } finally {
      client.release();
    }
  }

  async getRulesForPlan(
    datasourceId: string,
    tables: string[],
    minConfidence = 0.5,
  ): Promise<string[]> {
    if (tables.length === 0) return [];
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ rule_text: string }>(
        `SELECT rule_text FROM tribal_rules
         WHERE datasource_id = $1
           AND confidence >= $2
           AND applies_to_tables && $3
         ORDER BY times_prevented DESC, confidence DESC
         LIMIT 5`,
        [datasourceId, minConfidence, tables],
      );
      return result.rows.map((r) => r.rule_text);
    } finally {
      client.release();
    }
  }

  async incrementPrevented(
    datasourceId: string,
    errorClass: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE tribal_rules
         SET times_prevented = times_prevented + 1,
             confidence      = LEAST(confidence + 0.05, 1.0),
             updated_at      = NOW()
         WHERE datasource_id = $1 AND error_class = $2`,
        [datasourceId, errorClass],
      );
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
