import { z } from 'zod';

export const DiscoveredColumnSchema = z.object({
  name: z.string(),
  dataType: z.string(),
  nativeType: z.string(),
  isNullable: z.boolean(),
  isPrimaryKey: z.boolean(),
  isUnique: z.boolean(),
  defaultValue: z.string().nullable(),
  comment: z.string().nullable(),
});

export type DiscoveredColumn = z.infer<typeof DiscoveredColumnSchema>;

export const DiscoveredTableSchema = z.object({
  name: z.string(),
  schema: z.string(),
  type: z.enum(['TABLE', 'VIEW']),
  columns: z.array(DiscoveredColumnSchema),
});

export type DiscoveredTable = z.infer<typeof DiscoveredTableSchema>;

export const ForeignKeyInfoSchema = z.object({
  constraintName: z.string(),
  fromSchema: z.string(),
  fromTable: z.string(),
  fromColumns: z.array(z.string()),
  toSchema: z.string(),
  toTable: z.string(),
  toColumns: z.array(z.string()),
});

export type ForeignKeyInfo = z.infer<typeof ForeignKeyInfoSchema>;

export const DiscoveredSchemaSchema = z.object({
  datasourceId: z.string(),
  datasourceProvider: z.string(),
  discoveredAt: z.string(),
  tables: z.array(DiscoveredTableSchema),
  foreignKeys: z.array(ForeignKeyInfoSchema),
});

export type DiscoveredSchema = z.infer<typeof DiscoveredSchemaSchema>;

export interface SampleData {
  columns: string[];
  rows: unknown[][];
}

export interface ColumnStats {
  totalCount: number;
  nullCount: number;
  distinctCount: number;
  sampleValues: unknown[];
}

export type DiscoveryStatus = 'pending' | 'running' | 'ready' | 'failed';

export const DiscoveryStatusRecordSchema = z.object({
  datasourceId: z.string(),
  status: z.enum(['pending', 'running', 'ready', 'failed']),
  updatedAt: z.string(),
  error: z.string().nullable(),
  schema: DiscoveredSchemaSchema.nullable(),
});

export type DiscoveryStatusRecord = z.infer<typeof DiscoveryStatusRecordSchema>;

export type SemanticModelStatus = 'pending' | 'running' | 'ready' | 'failed';

export interface SemanticModelStatusRecord {
  datasourceId: string;
  status: SemanticModelStatus;
  updatedAt: string;
  generatedAt: string | null;
  error: string | null;
}
