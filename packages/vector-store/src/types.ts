export type FieldMetadata = {
  field_id: string;
  label: string;
  type: 'measure' | 'dimension' | 'business_rule' | 'workload_hint';
  table: string;
  sql: string;
  filters?: string[];
  format?: string;
  description: string;
  synonyms: string[];
  when_to_use?: string;
  join_path?: string;
  join_ref?: string;
};

export type TermIndexRecord = {
  /** "{datasourceId}::{table}.{fieldId}" */
  id: string;
  datasource_id: string;
  embedding: number[];
  metadata: FieldMetadata;
};

export type SearchResult = FieldMetadata & { score: number };
