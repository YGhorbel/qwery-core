export const CREATE_TOKEN_USAGE_SQL = `
CREATE TABLE IF NOT EXISTS token_usage (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  datasource_id TEXT,
  model_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage (model_id);
`;

export type StoredTokenUsage = {
  id: string;
  conversationId: string;
  datasourceId?: string | null;
  modelId: string;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
};
