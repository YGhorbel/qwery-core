/**
 * Agent 03 — Relationship Mapper
 * Detects join paths from FK constraints and naming heuristics.
 * Supports both snake_case FKs ({name}_id) and compact FKs ({name}id).
 */
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { JoinDefinition } from '../types.js';

type TableInfo = {
  id: number;
  name: string;
  columns: Array<{ name: string; is_nullable: boolean }>;
};

function buildTableIndex(metadata: DatasourceMetadata): Map<number, TableInfo> {
  const index = new Map<number, TableInfo>();
  for (const t of metadata.tables ?? []) {
    index.set(t.id, { id: t.id, name: t.name, columns: [] });
  }
  for (const col of metadata.columns ?? []) {
    const table = index.get(col.table_id);
    if (table) {
      table.columns.push({ name: col.name, is_nullable: col.is_nullable });
    }
  }
  return index;
}

function toSingular(name: string): string {
  if (name.endsWith('ies')) return name.slice(0, -3) + 'y';
  if (name.endsWith('ses') || name.endsWith('xes') || name.endsWith('zes'))
    return name.slice(0, -2);
  if (name.endsWith('s')) return name.slice(0, -1);
  return name;
}

/**
 * Given a column name, extract the FK target prefix and PK column name.
 * Handles two patterns:
 *   - snake_case:  customer_id  → prefix "customer", pk "id"
 *   - compact:     raceid       → prefix "race",     pk "raceid"
 */
function parseFkColumn(
  colName: string,
): { prefix: string; referencedPk: string } | null {
  // Pattern 1: ends with _id
  const snakeMatch = colName.match(/^(.+)_id$/i);
  if (snakeMatch) {
    return { prefix: snakeMatch[1]!.toLowerCase(), referencedPk: 'id' };
  }
  // Pattern 2: ends with id (no underscore) and has at least 3 chars before id
  if (colName.length > 3 && colName.toLowerCase().endsWith('id')) {
    const prefix = colName.slice(0, -2).toLowerCase();
    return { prefix, referencedPk: colName }; // PK has the same name as FK col
  }
  return null;
}

function inferJoinsFromHeuristics(
  tables: Map<number, TableInfo>,
): JoinDefinition[] {
  const joins: JoinDefinition[] = [];
  const seen = new Set<string>();

  // Build lookup: exact name and singular form → TableInfo
  const tableByName = new Map<string, TableInfo>();
  for (const t of tables.values()) {
    tableByName.set(t.name.toLowerCase(), t);
    tableByName.set(toSingular(t.name.toLowerCase()), t);
  }

  for (const sourceTable of tables.values()) {
    for (const col of sourceTable.columns) {
      const parsed = parseFkColumn(col.name);
      if (!parsed) continue;

      const { prefix, referencedPk } = parsed;

      // Try exact prefix, then prefix+'s' (plural)
      const referencedTable =
        tableByName.get(prefix) ??
        tableByName.get(prefix + 's') ??
        tableByName.get(prefix + 'es');

      if (!referencedTable || referencedTable.id === sourceTable.id) continue;

      const key = `${sourceTable.name}__${referencedTable.name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const joinType: 'left_outer' | 'inner' = col.is_nullable ? 'left_outer' : 'inner';

      joins.push({
        from: sourceTable.name,
        to: referencedTable.name,
        type: joinType,
        sql_on: `${sourceTable.name}.${col.name} = ${referencedTable.name}.${referencedPk}`,
        relationship: 'many_to_one',
      });
    }
  }

  return joins;
}

export function runRelationshipMapper(
  metadata: DatasourceMetadata,
): Record<string, JoinDefinition> {
  const tables = buildTableIndex(metadata);
  const joins = inferJoinsFromHeuristics(tables);

  const result: Record<string, JoinDefinition> = {};
  for (const join of joins) {
    const key = `${join.from}__${join.to}`;
    result[key] = join;
  }
  return result;
}
