export type LabelEntry = {
  label: string;
  description: string;
  synonyms: string[];
  raw_column?: string;
};

/** keyed by "tableName.columnName" */
export type LabelMap = Record<string, LabelEntry>;

export type MeasureDefinition = {
  label: string;
  description: string;
  sql: string;
  filters: string[];
  format: 'currency_usd' | 'integer' | 'percent' | 'decimal';
  table: string;
  synonyms: string[];
  when_to_use?: string;
};

export type DimensionDefinition = {
  label: string;
  sql: string;
  table: string;
  type: 'string' | 'number' | 'date' | 'boolean';
  synonyms: string[];
  enum_vals?: string[];
};

export type BusinessRuleDefinition = {
  label: string;
  description: string;
  sql: string;
  type: boolean;
  hidden?: boolean;
  table: string;
  synonyms: string[];
};

export type JoinDefinition = {
  from: string;
  to: string;
  type: 'left_outer' | 'inner';
  sql_on: string;
  relationship: 'many_to_one' | 'one_to_many' | 'one_to_one';
};

export type SemanticLayer = {
  measures: Record<string, MeasureDefinition>;
  dimensions: Record<string, DimensionDefinition>;
  business_rules: Record<string, BusinessRuleDefinition>;
  joins: Record<string, JoinDefinition>;
};

export type ConceptDefinition = {
  is_a: string[];
  maps_to: string;
  id_col: string;
  properties: Record<string, string>;
};

export type OntologyRelationship = {
  from: string;
  to: string;
  type: string;
  cardinality: 'many_to_one' | 'one_to_many' | 'one_to_one';
  join_ref: string;
};

export type InferenceRule = {
  id: string;
  if: string;
  then: string;
  field?: string;
  derive?: string;
};

export type Ontology = {
  concepts: Record<string, ConceptDefinition>;
  relationships: OntologyRelationship[];
  inference_rules: InferenceRule[];
};

export type ValidationResult = {
  fieldId: string;
  status: 'ok' | 'warn' | 'fail';
  value?: unknown;
  nullPct?: number;
  error?: string;
  suggestion?: string;
};

export type PipelineArtifacts = {
  labelMap: LabelMap;
  semanticLayer: SemanticLayer;
  ontology: Ontology;
  validationResults: ValidationResult[];
};
