import { z } from 'zod';

export const SemanticPlanSchema = z.object({
  concepts: z.array(z.string()),
  properties: z.array(z.string()),
  relationships: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        type: z.enum(['has_one', 'has_many', 'belongs_to', 'many_to_many']),
      }),
    )
    .default([]),
  filters: z
    .array(
      z.object({
        property: z.string(),
        operator: z.enum(['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'IN', 'NOT IN']),
        value: z.unknown(),
      }),
    )
    .default([]),
  aggregations: z
    .array(
      z.object({
        property: z.string(),
        function: z.enum(['sum', 'avg', 'count', 'min', 'max']),
        alias: z.string().optional(),
      }),
    )
    .default([]),
  groupBy: z.array(z.string()).default([]),
  ordering: z
    .array(
      z.object({
        property: z.string(),
        direction: z.enum(['ASC', 'DESC']),
      }),
    )
    .default([]),
  limit: z.number().nullable().optional().transform((val) => val ?? undefined),
});

export type SemanticPlan = z.infer<typeof SemanticPlanSchema>;

export interface SemanticTableMapping {
  concept_id: string;
  table_schema: string;
  table_name: string;
  mapping_id: string;
  column_mappings: Array<{
    column_name: string;
    property_id: string;
  }>;
}

export interface JoinPath {
  from_table: { schema: string; name: string };
  to_table: { schema: string; name: string };
  from_column: string;
  to_column: string;
  relationship_type: 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many';
}

export interface CompiledQuery {
  sql: string;
  parameters: unknown[];
  table_mappings: SemanticTableMapping[];
  join_paths: JoinPath[];
}
