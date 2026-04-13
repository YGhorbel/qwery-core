import type { RelationshipCandidate } from '../../../osi/types';
import type { DiscoveredSchema, ForeignKeyInfo } from '../../../types';
import type { AgentStateType } from '../state';

const FK_SUFFIXES = ['_id', '_key', '_code', '_ref', '_fk', '_num', '_no'];

function normalize(name: string): string {
  return name.toLowerCase().replace(/[_\s-]/g, '');
}

function datasetNameFromTable(schema: string, table: string): string {
  return `${schema}_${table}`.replace(/[^a-zA-Z0-9]/g, '_');
}

/** Find FK candidates by column naming convention */
function findNamingCandidates(
  schema: DiscoveredSchema,
): RelationshipCandidate[] {
  const tableByNorm = new Map(schema.tables.map((t) => [normalize(t.name), t]));

  const candidates: RelationshipCandidate[] = [];

  for (const fromTable of schema.tables) {
    for (const col of fromTable.columns) {
      if (col.isPrimaryKey) continue;

      let matchedSuffix: string | null = null;
      for (const suffix of FK_SUFFIXES) {
        if (col.name.toLowerCase().endsWith(suffix)) {
          matchedSuffix = suffix;
          break;
        }
      }
      if (!matchedSuffix) continue;

      const prefix = normalize(
        col.name.slice(0, col.name.length - matchedSuffix.length),
      );
      if (!prefix) continue;

      const toTable = tableByNorm.get(prefix);
      if (!toTable) continue;
      if (
        toTable.name === fromTable.name &&
        toTable.schema === fromTable.schema
      )
        continue;

      // Find PK column of target table
      const pkCol = toTable.columns.find((c) => c.isPrimaryKey);
      if (!pkCol) continue;

      // Type compatibility: both should be same base type
      if (col.dataType.split(' ')[0] !== pkCol.dataType.split(' ')[0]) continue;

      candidates.push({
        constraintName: `heuristic_${fromTable.schema}_${fromTable.name}_${col.name}`,
        fromDataset: datasetNameFromTable(fromTable.schema, fromTable.name),
        toDataset: datasetNameFromTable(toTable.schema, toTable.name),
        fromColumns: [col.name],
        toColumns: [pkCol.name],
        source: 'naming_heuristic',
        confidence: 'low',
      });
    }
  }

  return candidates;
}

function fkToCandidate(fk: ForeignKeyInfo): RelationshipCandidate {
  return {
    constraintName: fk.constraintName,
    fromDataset: datasetNameFromTable(fk.fromSchema, fk.fromTable),
    toDataset: datasetNameFromTable(fk.toSchema, fk.toTable),
    fromColumns: fk.fromColumns,
    toColumns: fk.toColumns,
    source: 'explicit_fk',
    confidence: 'high',
  };
}

export async function discoverRelationshipsNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const { schema } = state;

  // Explicit FK constraints → high confidence
  const explicitCandidates = schema.foreignKeys.map((fk) => fkToCandidate(fk));

  // Build a set of explicit FK pairs to avoid duplicates
  const explicitPairs = new Set(
    explicitCandidates.map(
      (c) => `${c.fromDataset}:${c.fromColumns.join(',')}→${c.toDataset}`,
    ),
  );

  // Naming heuristics → low confidence, deduplicated against explicit
  const heuristicCandidates = findNamingCandidates(schema).filter((c) => {
    const key = `${c.fromDataset}:${c.fromColumns.join(',')}→${c.toDataset}`;
    return !explicitPairs.has(key);
  });

  const relationshipCandidates = [
    ...explicitCandidates,
    ...heuristicCandidates,
  ];

  return { relationshipCandidates };
}
