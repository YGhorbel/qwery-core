import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type {
  ConcreteTableMapping,
  ConcreteColumnMapping,
  Relationship,
} from '../models/ontology.schema';
import type { DatasourceMetadata, Table, Column } from '@qwery/domain/entities';
import type { MappingResult } from '../mapping/generator';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface ConcreteLayer {
  datasourceId: string;
  tableMappings: ConcreteTableMapping[];
  columnMappings: ConcreteColumnMapping[];
  relationships: Relationship[];
}

/**
 * Build concrete layer from datasource metadata and mappings.
 */
export function buildConcreteLayer(
  datasourceId: string,
  metadata: DatasourceMetadata,
  mappings: MappingResult,
): ConcreteLayer {
  const logger = getLogger();

  const tableMappings: ConcreteTableMapping[] = [];
  const columnMappings: ConcreteColumnMapping[] = [];
  const relationships: Relationship[] = [];

  // Build table mappings
  for (const tableMapping of mappings.table_mappings) {
    tableMappings.push({
      datasourceId,
      schema: tableMapping.table_schema,
      table: tableMapping.table_name,
      conceptId: tableMapping.concept_id,
    });

    // Build column mappings
    for (const columnMapping of tableMapping.column_mappings) {
      columnMappings.push({
        datasourceId,
        schema: tableMapping.table_schema,
        table: tableMapping.table_name,
        column: columnMapping.column_name,
        conceptId: tableMapping.concept_id,
        propertyId: columnMapping.property_id,
      });
    }
  }

  // Build relationships from foreign keys
  for (const table of metadata.tables) {
    for (const fk of table.relationships || []) {
      const sourceMapping = mappings.table_mappings.find(
        (m) => m.table_schema === table.schema && m.table_name === table.name,
      );
      const targetMapping = mappings.table_mappings.find(
        (m) =>
          m.table_schema === fk.target_table_schema && m.table_name === fk.target_table_name,
      );

      if (sourceMapping && targetMapping) {
        relationships.push({
          target: targetMapping.concept_id,
          type: inferRelationshipType(table, fk, metadata),
          label: `${sourceMapping.concept_id} → ${targetMapping.concept_id}`,
          description: `FK: ${fk.source_column_name} → ${fk.target_table_name}`,
        });
      }
    }
  }

  logger.then((l) => {
    l.info('[ConcreteLayer] Concrete layer built', {
      datasourceId,
      tableMappingsCount: tableMappings.length,
      columnMappingsCount: columnMappings.length,
      relationshipsCount: relationships.length,
    });
  });

  return {
    datasourceId,
    tableMappings,
    columnMappings,
    relationships,
  };
}

function inferRelationshipType(
  sourceTable: Table,
  fk: { source_column_name: string; target_table_name: string; target_table_schema: string },
  metadata: DatasourceMetadata,
): 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many' {
  const targetTable = metadata.tables.find(
    (t) => t.schema === fk.target_table_schema && t.name === fk.target_table_name,
  );

  if (!targetTable) {
    return 'belongs_to';
  }

  // Check if source column is unique (likely belongs_to)
  const sourceColumn = metadata.columns.find(
    (c) =>
      c.schema === sourceTable.schema &&
      c.table === sourceTable.name &&
      c.name === fk.source_column_name,
  );

  if (sourceColumn?.is_unique) {
    return 'belongs_to';
  }

  // Default to has_many for foreign key patterns
  if (fk.source_column_name.toLowerCase().includes('_id')) {
    return 'belongs_to';
  }

  return 'has_many';
}

/**
 * Create mappings between abstract and concrete layers.
 */
export function createLayerMappings(
  abstractConcepts: Array<{ id: string }>,
  concreteLayers: ConcreteLayer[],
): {
  abstractToConcrete: Record<string, string[]>;
  concreteToAbstract: Record<string, string>;
} {
  const abstractToConcrete: Record<string, string[]> = {};
  const concreteToAbstract: Record<string, string> = {};

  // Build mappings from concrete layers
  for (const concreteLayer of concreteLayers) {
    for (const tableMapping of concreteLayer.tableMappings) {
      const concreteKey = `${tableMapping.datasourceId}:${tableMapping.schema}.${tableMapping.table}`;
      const abstractConceptId = tableMapping.conceptId;

      // Concrete to abstract
      concreteToAbstract[concreteKey] = abstractConceptId;

      // Abstract to concrete
      if (!abstractToConcrete[abstractConceptId]) {
        abstractToConcrete[abstractConceptId] = [];
      }
      abstractToConcrete[abstractConceptId]!.push(concreteKey);
    }
  }

  return {
    abstractToConcrete,
    concreteToAbstract,
  };
}
