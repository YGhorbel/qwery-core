import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { SemanticTableMapping, JoinPath } from '../compiler/types';
import type { Ontology } from '../models/ontology.schema';
import { OntologyGraph } from './ontology-graph';
import { loadMappings } from '../mapping/store';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface GraphJoinInferenceOptions {
  tableMappings: SemanticTableMapping[];
  ontology: Ontology;
  ontologyVersion: string;
  datasourceId: string;
  relationships: Array<{
    from: string;
    to: string;
    type: 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many';
  }>;
}

/**
 * Graph-based join inference using ontology graph instead of raw metadata.
 * Supports multi-hop joins and discovered relationships.
 */
export async function inferJoinPathsFromGraph(
  options: GraphJoinInferenceOptions,
): Promise<JoinPath[]> {
  const { tableMappings, ontology, ontologyVersion, datasourceId, relationships } = options;
  const logger = await getLogger();

  logger.info('[GraphJoinInference] Starting graph-based join inference', {
    tableMappingsCount: tableMappings.length,
    relationshipsCount: relationships.length,
    conceptsCount: ontology.ontology.concepts.length,
  });

  const graph = new OntologyGraph(ontology);
  const joinPaths: JoinPath[] = [];

  // Build concept to table mapping
  const conceptToTableMap = new Map<string, SemanticTableMapping>();
  for (const mapping of tableMappings) {
    conceptToTableMap.set(mapping.concept_id, mapping);
  }

  // Process each relationship
  for (const rel of relationships) {
    logger.debug('[GraphJoinInference] Processing relationship', {
      from: rel.from,
      to: rel.to,
      type: rel.type,
    });

    const fromMapping = conceptToTableMap.get(rel.from);
    const toMapping = conceptToTableMap.get(rel.to);

    if (!fromMapping || !toMapping) {
      logger.warn('[GraphJoinInference] Missing mapping for relationship', {
        from: rel.from,
        to: rel.to,
      });
      continue;
    }

    // Find path in graph
    const graphPath = graph.findShortestConceptPath(rel.from, rel.to);

    if (!graphPath) {
      logger.warn('[GraphJoinInference] No path found in graph', {
        from: rel.from,
        to: rel.to,
      });
      continue;
    }

    // Convert graph path to join path
    const joinPath = await convertGraphPathToJoinPath(
      graphPath,
      fromMapping,
      toMapping,
      tableMappings,
      ontologyVersion,
      datasourceId,
      rel.type,
    );

    if (joinPath) {
      joinPaths.push(joinPath);
    }
  }

  logger.info('[GraphJoinInference] Join inference complete', {
    joinPathsGenerated: joinPaths.length,
    joinPaths: joinPaths.map((jp) => ({
      from: `${jp.from_table.schema}.${jp.from_table.name}`,
      to: `${jp.to_table.schema}.${jp.to_table.name}`,
      type: jp.relationship_type,
    })),
  });

  return joinPaths;
}

async function convertGraphPathToJoinPath(
  graphPath: { nodes: string[]; edges: Array<{ relationshipType?: string; targetConcept?: string; sourceConcept?: string }> },
  fromMapping: SemanticTableMapping,
  toMapping: SemanticTableMapping,
  allMappings: SemanticTableMapping[],
  ontologyVersion: string,
  datasourceId: string,
  relationshipType: 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many',
): Promise<JoinPath | null> {
  const logger = await getLogger();

  // For direct relationships, find the join columns from mappings
  if (graphPath.nodes.length === 2) {
    // Direct relationship - find join columns
    const joinColumns = await findJoinColumns(
      fromMapping,
      toMapping,
      ontologyVersion,
      datasourceId,
    );

    if (joinColumns) {
      return {
        from_table: {
          schema: fromMapping.table_schema,
          name: fromMapping.table_name,
        },
        to_table: {
          schema: toMapping.table_schema,
          name: toMapping.table_name,
        },
        from_column: joinColumns.fromColumn,
        to_column: joinColumns.toColumn,
        relationship_type: relationshipType,
      };
    }
  }

  // Multi-hop path - need to resolve intermediate joins
  // For now, return direct join if possible, otherwise log warning
  logger.warn('[GraphJoinInference] Multi-hop path detected, using direct join', {
    pathLength: graphPath.nodes.length,
    from: fromMapping.concept_id,
    to: toMapping.concept_id,
  });

  // Try to find direct join columns
  const joinColumns = await findJoinColumns(
    fromMapping,
    toMapping,
    ontologyVersion,
    datasourceId,
  );

  if (joinColumns) {
    return {
      from_table: {
        schema: fromMapping.table_schema,
        name: fromMapping.table_name,
      },
      to_table: {
        schema: toMapping.table_schema,
        name: toMapping.table_name,
      },
      from_column: joinColumns.fromColumn,
      to_column: joinColumns.toColumn,
      relationship_type: relationshipType,
    };
  }

  return null;
}

async function findJoinColumns(
  fromMapping: SemanticTableMapping,
  toMapping: SemanticTableMapping,
  ontologyVersion: string,
  datasourceId: string,
): Promise<{ fromColumn: string; toColumn: string } | null> {
  const logger = await getLogger();

  // Load mappings to get column information
  const mappings = await loadMappings(datasourceId, ontologyVersion);
  
  const fromMappingData = mappings.find(
    (m) =>
      m.table_schema === fromMapping.table_schema &&
      m.table_name === fromMapping.table_name &&
      m.concept_id === fromMapping.concept_id,
  );

  const toMappingData = mappings.find(
    (m) =>
      m.table_schema === toMapping.table_schema &&
      m.table_name === toMapping.table_name &&
      m.concept_id === toMapping.concept_id,
  );

  if (!fromMappingData || !toMappingData) {
    return null;
  }

  // Look for common property patterns (e.g., id columns)
  const fromIdColumns = fromMappingData.column_mappings.filter((cm) =>
    cm.column_name.toLowerCase().includes('id'),
  );
  const toIdColumns = toMappingData.column_mappings.filter((cm) =>
    cm.column_name.toLowerCase().includes('id'),
  );

  // Try to match: {table}_id -> id pattern
  const toTableName = toMapping.table_name.toLowerCase();
  for (const fromCol of fromIdColumns) {
    const fromColName = fromCol.column_name.toLowerCase();
    
    // Pattern: {target_table}_id -> id
    if (fromColName === `${toTableName}_id` || fromColName === `${toTableName}id`) {
      const toIdCol = toIdColumns.find((c) => c.column_name.toLowerCase() === 'id');
      if (toIdCol) {
        logger.debug('[GraphJoinInference] Found join columns via pattern matching', {
          fromColumn: fromCol.column_name,
          toColumn: toIdCol.column_name,
        });
        return {
          fromColumn: fromCol.column_name,
          toColumn: toIdCol.column_name,
        };
      }
    }
  }

  // Try reverse: id -> {source_table}_id
  const fromTableName = fromMapping.table_name.toLowerCase();
  for (const toCol of toIdColumns) {
    const toColName = toCol.column_name.toLowerCase();
    
    if (toColName === `${fromTableName}_id` || toColName === `${fromTableName}id`) {
      const fromIdCol = fromIdColumns.find((c) => c.column_name.toLowerCase() === 'id');
      if (fromIdCol) {
        logger.debug('[GraphJoinInference] Found join columns via reverse pattern matching', {
          fromColumn: fromIdCol.column_name,
          toColumn: toCol.column_name,
        });
        return {
          fromColumn: fromIdCol.column_name,
          toColumn: toCol.column_name,
        };
      }
    }
  }

  // Fallback: use first id column from each table
  if (fromIdColumns.length > 0 && toIdColumns.length > 0) {
    logger.debug('[GraphJoinInference] Using fallback id columns', {
      fromColumn: fromIdColumns[0]!.column_name,
      toColumn: toIdColumns[0]!.column_name,
    });
    return {
      fromColumn: fromIdColumns[0]!.column_name,
      toColumn: toIdColumns[0]!.column_name,
    };
  }

  return null;
}
