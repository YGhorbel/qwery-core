import { Pool } from 'pg';
import { CREATE_TOKEN_USAGE_SQL, type StoredTokenUsage } from './token-schema.js';

export type DailyTokenStat = {
  date: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
};

export type ModelTokenStat = {
  model_id: string;
  provider_id: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  session_count: number;
};

export class TokenStore {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 3 });
  }

  async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(CREATE_TOKEN_USAGE_SQL);
    } finally {
      client.release();
    }
  }

  async store(usage: StoredTokenUsage): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO token_usage (
          id, conversation_id, datasource_id, model_id, provider_id,
          input_tokens, output_tokens, reasoning_tokens, cached_tokens
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO NOTHING`,
        [
          usage.id,
          usage.conversationId,
          usage.datasourceId ?? null,
          usage.modelId,
          usage.providerId,
          usage.inputTokens,
          usage.outputTokens,
          usage.reasoningTokens,
          usage.cachedTokens,
        ],
      );
    } finally {
      client.release();
    }
  }

  async getDailyStats(days = 30): Promise<DailyTokenStat[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<DailyTokenStat>(
        `SELECT
          DATE(created_at)::text AS date,
          SUM(input_tokens)::int AS input_tokens,
          SUM(output_tokens)::int AS output_tokens,
          SUM(reasoning_tokens)::int AS reasoning_tokens,
          SUM(input_tokens + output_tokens)::int AS total_tokens
         FROM token_usage
         WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
         GROUP BY DATE(created_at)
         ORDER BY DATE(created_at) ASC`,
        [String(days)],
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  async getModelStats(): Promise<ModelTokenStat[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<ModelTokenStat>(
        `SELECT
          model_id,
          provider_id,
          SUM(input_tokens)::int AS input_tokens,
          SUM(output_tokens)::int AS output_tokens,
          SUM(reasoning_tokens)::int AS reasoning_tokens,
          COUNT(*)::int AS session_count
         FROM token_usage
         GROUP BY model_id, provider_id
         ORDER BY SUM(input_tokens + output_tokens) DESC`,
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  async getTotals(): Promise<{
    totalInput: number;
    totalOutput: number;
    totalReasoning: number;
    sessionCount: number;
  }> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{
        total_input: string;
        total_output: string;
        total_reasoning: string;
        session_count: string;
      }>(
        `SELECT
          COALESCE(SUM(input_tokens), 0)::text AS total_input,
          COALESCE(SUM(output_tokens), 0)::text AS total_output,
          COALESCE(SUM(reasoning_tokens), 0)::text AS total_reasoning,
          COUNT(*)::text AS session_count
         FROM token_usage`,
      );
      const row = result.rows[0];
      return {
        totalInput: parseInt(row?.total_input ?? '0', 10),
        totalOutput: parseInt(row?.total_output ?? '0', 10),
        totalReasoning: parseInt(row?.total_reasoning ?? '0', 10),
        sessionCount: parseInt(row?.session_count ?? '0', 10),
      };
    } finally {
      client.release();
    }
  }
}
