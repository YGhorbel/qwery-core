import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { DatasourceMetadata, Table, Column } from '@qwery/domain/entities';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface SchemaChange {
  type: 'table_added' | 'table_removed' | 'table_modified' | 'column_added' | 'column_removed' | 'column_modified';
  table?: { schema: string; name: string };
  column?: { schema: string; table: string; name: string };
  previousValue?: unknown;
  currentValue?: unknown;
}

export interface SchemaDiff {
  addedTables: Table[];
  removedTables: Table[];
  modifiedTables: Array<{
    table: Table;
    addedColumns: Column[];
    removedColumns: Column[];
    modifiedColumns: Array<{
      column: Column;
      previous: Column;
    }>;
  }>;
  changes: SchemaChange[];
}

/**
 * Detects changes in datasource schemas by comparing current and previous metadata.
 */
export async function detectSchemaChanges(
  previousMetadata: DatasourceMetadata | null,
  currentMetadata: DatasourceMetadata,
): Promise<SchemaDiff> {
  const logger = await getLogger();

  if (!previousMetadata) {
    logger.info('[ChangeDetector] No previous metadata, all tables are new', {
      tablesCount: currentMetadata.tables.length,
    });
    return {
      addedTables: currentMetadata.tables,
      removedTables: [],
      modifiedTables: [],
      changes: currentMetadata.tables.map((table) => ({
        type: 'table_added' as const,
        table: { schema: table.schema, name: table.name },
      })),
    };
  }

  logger.info('[ChangeDetector] Comparing schemas', {
    previousTablesCount: previousMetadata.tables.length,
    currentTablesCount: currentMetadata.tables.length,
  });

  const previousTableMap = new Map<string, Table>();
  for (const table of previousMetadata.tables) {
    const key = `${table.schema}.${table.name}`;
    previousTableMap.set(key, table);
  }

  const currentTableMap = new Map<string, Table>();
  for (const table of currentMetadata.tables) {
    const key = `${table.schema}.${table.name}`;
    currentTableMap.set(key, table);
  }

  const addedTables: Table[] = [];
  const removedTables: Table[] = [];
  const modifiedTables: Array<{
    table: Table;
    addedColumns: Column[];
    removedColumns: Column[];
    modifiedColumns: Array<{ column: Column; previous: Column }>;
  }> = [];
  const changes: SchemaChange[] = [];

  // Find added tables
  for (const [key, table] of currentTableMap.entries()) {
    if (!previousTableMap.has(key)) {
      addedTables.push(table);
      changes.push({
        type: 'table_added',
        table: { schema: table.schema, name: table.name },
      });
    }
  }

  // Find removed tables
  for (const [key, table] of previousTableMap.entries()) {
    if (!currentTableMap.has(key)) {
      removedTables.push(table);
      changes.push({
        type: 'table_removed',
        table: { schema: table.schema, name: table.name },
      });
    }
  }

  // Find modified tables (column changes)
  for (const [key, currentTable] of currentTableMap.entries()) {
    const previousTable = previousTableMap.get(key);
    if (!previousTable) {
      continue;
    }

    const previousColumns = previousMetadata.columns.filter(
      (c) => c.schema === previousTable.schema && c.table === previousTable.name,
    );
    const currentColumns = currentMetadata.columns.filter(
      (c) => c.schema === currentTable.schema && c.table === currentTable.name,
    );

    const previousColumnMap = new Map<string, Column>();
    for (const col of previousColumns) {
      previousColumnMap.set(col.name, col);
    }

    const currentColumnMap = new Map<string, Column>();
    for (const col of currentColumns) {
      currentColumnMap.set(col.name, col);
    }

    const addedColumns: Column[] = [];
    const removedColumns: Column[] = [];
    const modifiedColumns: Array<{ column: Column; previous: Column }> = [];

    // Find added columns
    for (const [colName, col] of currentColumnMap.entries()) {
      if (!previousColumnMap.has(colName)) {
        addedColumns.push(col);
        changes.push({
          type: 'column_added',
          table: { schema: currentTable.schema, name: currentTable.name },
          column: { schema: col.schema, table: col.table, name: col.name },
        });
      }
    }

    // Find removed columns
    for (const [colName, col] of previousColumnMap.entries()) {
      if (!currentColumnMap.has(colName)) {
        removedColumns.push(col);
        changes.push({
          type: 'column_removed',
          table: { schema: previousTable.schema, name: previousTable.name },
          column: { schema: col.schema, table: col.table, name: col.name },
        });
      }
    }

    // Find modified columns
    for (const [colName, currentCol] of currentColumnMap.entries()) {
      const previousCol = previousColumnMap.get(colName);
      if (!previousCol) {
        continue;
      }

      if (hasColumnChanged(previousCol, currentCol)) {
        modifiedColumns.push({ column: currentCol, previous: previousCol });
        changes.push({
          type: 'column_modified',
          table: { schema: currentTable.schema, name: currentTable.name },
          column: { schema: currentCol.schema, table: currentCol.table, name: currentCol.name },
          previousValue: previousCol,
          currentValue: currentCol,
        });
      }
    }

    if (addedColumns.length > 0 || removedColumns.length > 0 || modifiedColumns.length > 0) {
      modifiedTables.push({
        table: currentTable,
        addedColumns,
        removedColumns,
        modifiedColumns,
      });
      changes.push({
        type: 'table_modified',
        table: { schema: currentTable.schema, name: currentTable.name },
      });
    }
  }

  logger.info('[ChangeDetector] Schema comparison complete', {
    addedTablesCount: addedTables.length,
    removedTablesCount: removedTables.length,
    modifiedTablesCount: modifiedTables.length,
    totalChanges: changes.length,
  });

  return {
    addedTables,
    removedTables,
    modifiedTables,
    changes,
  };
}

function hasColumnChanged(previous: Column, current: Column): boolean {
  return (
    previous.data_type !== current.data_type ||
    previous.is_nullable !== current.is_nullable ||
    previous.is_unique !== current.is_unique ||
    previous.default_value !== current.default_value
  );
}

/**
 * Get impact analysis: which concepts are affected by schema changes
 */
export function analyzeChangeImpact(
  diff: SchemaDiff,
  tableToConceptMap: Map<string, string>,
): {
  affectedConcepts: Set<string>;
  newConceptsNeeded: number;
  deprecatedConcepts: Set<string>;
} {
  const affectedConcepts = new Set<string>();
  const deprecatedConcepts = new Set<string>();

  // Removed tables → deprecated concepts
  for (const table of diff.removedTables) {
    const key = `${table.schema}.${table.name}`;
    const conceptId = tableToConceptMap.get(key);
    if (conceptId) {
      deprecatedConcepts.add(conceptId);
      affectedConcepts.add(conceptId);
    }
  }

  // Modified tables → affected concepts
  for (const modified of diff.modifiedTables) {
    const key = `${modified.table.schema}.${modified.table.name}`;
    const conceptId = tableToConceptMap.get(key);
    if (conceptId) {
      affectedConcepts.add(conceptId);
    }
  }

  return {
    affectedConcepts,
    newConceptsNeeded: diff.addedTables.length,
    deprecatedConcepts,
  };
}
