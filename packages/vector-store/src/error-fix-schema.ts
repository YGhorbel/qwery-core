export type StoredErrorFix = {
  id: string;
  datasource_id: string;
  question: string;
  failed_sql: string;
  error_class: string;
  evidence: string;
  edit_plan: string;
  corrected_sql: string;
};

export type ErrorFixRef = {
  failedSql: string;
  editPlan: string;
  correctedSql: string;
};

import { EMBEDDING_DIM } from './schema.js';

export const CREATE_ERROR_FIX_SQL = `
CREATE TABLE IF NOT EXISTS error_fix_pairs (
  id              TEXT PRIMARY KEY,
  datasource_id   TEXT NOT NULL,
  question        TEXT NOT NULL,
  question_emb    vector(${EMBEDDING_DIM}) NOT NULL,
  failed_sql      TEXT NOT NULL,
  error_class     TEXT NOT NULL,
  evidence        TEXT NOT NULL,
  edit_plan       TEXT NOT NULL,
  corrected_sql   TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS efp_error_class
  ON error_fix_pairs (datasource_id, error_class);
`;
