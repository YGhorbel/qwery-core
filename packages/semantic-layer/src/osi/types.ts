export interface OSIExpression {
  dialects: Array<{ dialect: string; expression: string }>;
}

export interface OSIAIContext {
  instructions?: string;
  synonyms?: string[];
  examples?: string[];
  sample_data?: unknown[];
  [key: string]: unknown;
}

export type OSIAIContextValue = string | OSIAIContext;

export interface OSICustomExtension {
  key: string;
  value: unknown;
}

export interface OSIField {
  name: string;
  expression: OSIExpression;
  label?: string;
  description?: string;
  dimension?: { is_time: boolean };
  ai_context?: OSIAIContextValue;
  custom_extensions?: OSICustomExtension[];
}

export interface OSIDataset {
  name: string;
  source: string; // "schema.table"
  label?: string;
  primary_key?: string[];
  unique_keys?: string[][];
  description?: string;
  ai_context?: OSIAIContextValue;
  fields?: OSIField[];
  custom_extensions?: OSICustomExtension[];
}

export interface OSIRelationship {
  name: string;
  from: string; // dataset name (many/child side)
  to: string; // dataset name (one/parent side)
  from_columns: string[];
  to_columns: string[];
  ai_context?: OSIAIContextValue;
  custom_extensions?: OSICustomExtension[];
}

export interface OSIMetric {
  name: string;
  expression: OSIExpression;
  description?: string;
  ai_context?: OSIAIContextValue;
}

export interface OSISemanticModelDefinition {
  name: string;
  description?: string;
  ai_context?: OSIAIContextValue;
  datasets: OSIDataset[];
  relationships?: OSIRelationship[];
  metrics?: OSIMetric[];
}

export interface OSISemanticModel {
  semantic_model: OSISemanticModelDefinition[];
}

export interface RelationshipCandidate {
  constraintName: string;
  fromDataset: string;
  toDataset: string;
  fromColumns: string[];
  toColumns: string[];
  source: 'explicit_fk' | 'naming_heuristic';
  confidence: 'high' | 'medium' | 'low';
  overlapRatio?: number;
}
