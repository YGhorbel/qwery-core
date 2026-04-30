import { EMBEDDING_DIM } from './schema.js';

export const CREATE_TRACES_SQL = `
CREATE TABLE IF NOT EXISTS query_traces (
  id                TEXT PRIMARY KEY,
  datasource_id     TEXT NOT NULL,
  question          TEXT NOT NULL,
  question_emb      vector(${EMBEDDING_DIM}) NOT NULL,
  keywords          TEXT[] NOT NULL,
  fields_used       JSONB NOT NULL,
  sql_final         TEXT NOT NULL,
  result_shape      JSONB NOT NULL,
  intent            TEXT NOT NULL,
  complexity        INTEGER NOT NULL,
  path_used         INTEGER NOT NULL,
  correction_applied JSONB,
  success           BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS traces_datasource
  ON query_traces (datasource_id);
`;

export type StoredQueryTrace = {
  id: string;
  datasourceId: string;
  question: string;
  keywords: string[];
  fieldsUsed: Array<{ field_id: string; label: string; sql: string }>;
  sqlFinal: string;
  resultShape: { columns: string[]; row_count: number };
  intent: string;
  complexity: number;
  pathUsed: number;
  correctionApplied: unknown | null;
  success: boolean;
};
