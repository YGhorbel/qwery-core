import type { DatasourceMetadata } from '@qwery/extensions-sdk';

import type {
  DiscoveredColumn,
  DiscoveredSchema,
  DiscoveredTable,
  ForeignKeyInfo,
} from '../types';

// Runtime shapes produced by buildMetadataFromInformationSchema — present via .passthrough()
interface TableRelationship {
  constraint_name: string;
  source_schema: string;
  source_table_name: string;
  source_column_name: string;
  target_table_schema: string;
  target_table_name: string;
  target_column_name: string;
}

interface PrimaryKey {
  name: string; // column name
}

interface RichTable {
  id: number;
  schema: string;
  name: string;
  primary_keys?: PrimaryKey[];
  relationships?: TableRelationship[];
}

interface RichColumn {
  schema: string;
  table: string;
  name: string;
  data_type: string;
  format?: string;
  is_nullable: boolean;
  is_unique?: boolean;
  default_value?: unknown;
  comment?: string | null;
  table_id?: number;
}

export function adaptMetadataToDiscoveredSchema(
  datasourceId: string,
  datasourceProvider: string,
  metadata: DatasourceMetadata,
  viewNames?: Set<string>,
): DiscoveredSchema {
  const tables = metadata.tables as unknown as RichTable[];
  const columns = metadata.columns as unknown as RichColumn[];

  const columnsByTable = new Map<string, RichColumn[]>();
  for (const col of columns) {
    const key = `${col.schema}.${col.table}`;
    const existing = columnsByTable.get(key) ?? [];
    existing.push(col);
    columnsByTable.set(key, existing);
  }

  const discoveredTables: DiscoveredTable[] = tables.map((table) => {
    const tableKey = `${table.schema}.${table.name}`;
    const pkNames = new Set((table.primary_keys ?? []).map((pk) => pk.name));
    const tableCols = columnsByTable.get(tableKey) ?? [];

    const discoveredColumns: DiscoveredColumn[] = tableCols.map((col) => ({
      name: col.name,
      dataType: col.data_type,
      nativeType: col.format ?? col.data_type,
      isNullable: col.is_nullable,
      isPrimaryKey: pkNames.has(col.name),
      isUnique: col.is_unique ?? false,
      defaultValue:
        col.default_value != null ? String(col.default_value) : null,
      comment: col.comment ?? null,
    }));

    const isView = viewNames?.has(tableKey) ?? false;

    return {
      name: table.name,
      schema: table.schema,
      type: isView ? 'VIEW' : 'TABLE',
      columns: discoveredColumns,
    };
  });

  // Build view name set from metadata.views if available
  const resolvedViewNames =
    viewNames ??
    new Set(
      (
        (
          metadata as unknown as {
            views?: Array<{ schema: string; name: string }>;
          }
        ).views ?? []
      ).map((v) => `${v.schema}.${v.name}`),
    );

  // Correct view/table type using resolved view names
  const finalTables = discoveredTables.map((t) => ({
    ...t,
    type: resolvedViewNames.has(`${t.schema}.${t.name}`)
      ? ('VIEW' as const)
      : ('TABLE' as const),
  }));

  const foreignKeys = extractForeignKeys(tables);

  return {
    datasourceId,
    datasourceProvider,
    discoveredAt: new Date().toISOString(),
    tables: finalTables,
    foreignKeys,
  };
}

function extractForeignKeys(tables: RichTable[]): ForeignKeyInfo[] {
  const fkMap = new Map<string, ForeignKeyInfo>();

  for (const table of tables) {
    for (const rel of table.relationships ?? []) {
      const existing = fkMap.get(rel.constraint_name);
      if (existing) {
        existing.fromColumns.push(rel.source_column_name);
        existing.toColumns.push(rel.target_column_name);
      } else {
        fkMap.set(rel.constraint_name, {
          constraintName: rel.constraint_name,
          fromSchema: rel.source_schema,
          fromTable: rel.source_table_name,
          fromColumns: [rel.source_column_name],
          toSchema: rel.target_table_schema,
          toTable: rel.target_table_name,
          toColumns: [rel.target_column_name],
        });
      }
    }
  }

  return Array.from(fkMap.values());
}
