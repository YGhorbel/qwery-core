export type TribalRule = {
  id: string;
  datasource_id: string;
  rule_text: string;
  applies_to_tables: string[];
  error_class: string;
  source_pair_count: number;
  confidence: number;
  times_prevented: number;
};

export const CREATE_TRIBAL_SQL = `
CREATE TABLE IF NOT EXISTS tribal_rules (
  id                TEXT PRIMARY KEY,
  datasource_id     TEXT NOT NULL,
  rule_text         TEXT NOT NULL,
  applies_to_tables TEXT[] NOT NULL,
  error_class       TEXT NOT NULL,
  source_pair_count INTEGER DEFAULT 0,
  confidence        FLOAT DEFAULT 0.7,
  times_prevented   INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tribal_datasource
  ON tribal_rules (datasource_id, error_class);
`;
