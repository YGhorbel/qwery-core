export const EMBEDDING_DIM = Number(process.env.QWERY_EMBEDDING_DIMENSIONS ?? 4096);

export const CREATE_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS term_index (
  id             TEXT PRIMARY KEY,
  datasource_id  TEXT NOT NULL,
  embedding      vector(${EMBEDDING_DIM}) NOT NULL,
  metadata       JSONB NOT NULL,
  indexed_at     TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW index omitted: pgvector caps at 2000 dims; use sequential cosine scan for >2000 dims
CREATE INDEX IF NOT EXISTS term_index_datasource
  ON term_index (datasource_id);

CREATE INDEX IF NOT EXISTS term_index_gin
  ON term_index USING gin(
    to_tsvector('english',
      coalesce(metadata->>'label', '') || ' ' ||
      coalesce(metadata->>'field_id', '') || ' ' ||
      coalesce(metadata->>'description', '')
    )
  );
`;
