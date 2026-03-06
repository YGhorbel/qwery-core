import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import { loadMappings } from './store';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface ConceptResolution {
  concept_id: string;
  table_schema: string;
  table_name: string;
  confidence: number;
  validated?: boolean;
  actualTableName?: string;
  actualSchema?: string;
}

export async function resolveConcept(
  datasourceId: string,
  term: string,
  ontologyVersion: string = '1.0.0',
): Promise<ConceptResolution | null> {
  const logger = await getLogger();

  logger.info('[MappingResolver] Resolving concept', {
    term,
    datasourceId,
    ontologyVersion,
  });

  const { getRedisIndex } = await import('../index/redis-index');
  const redisIndex = getRedisIndex();

  if (redisIndex) {
    const indexEntry = await redisIndex.getMappingIndex(datasourceId, term);
    if (indexEntry) {
      logger.info('[MappingResolver] Redis index entry found', {
        term,
        datasourceId,
        s3Path: indexEntry.s3Path,
      });
      const { getMinIOClient } = await import('../storage/minio-client');
      const minIOClient = getMinIOClient();
      if (minIOClient) {
        const object = await minIOClient.getObject(indexEntry.s3Path);
        if (object) {
          const mappings = JSON.parse(object.content) as { table_mappings: Array<{
            table_schema: string;
            table_name: string;
            concept_id: string;
            confidence: number;
            synonyms: string[];
          }> };
          const matching = mappings.table_mappings.find(
            (m) =>
              m.concept_id.toLowerCase().includes(term.toLowerCase()) ||
              m.table_name.toLowerCase().includes(term.toLowerCase()) ||
              m.synonyms.some((s) => s.toLowerCase().includes(term.toLowerCase())),
          );
          if (matching) {
            logger.info('[MappingResolver] Concept resolved via Redis index', {
              term,
              conceptId: matching.concept_id,
              table: `${matching.table_schema}.${matching.table_name}`,
              confidence: matching.confidence,
            });
            return {
              concept_id: matching.concept_id,
              table_schema: matching.table_schema,
              table_name: matching.table_name,
              confidence: matching.confidence,
            };
          }
        }
      }
    }
  }

  const allMappings = await loadMappings(datasourceId, ontologyVersion);
  const matching = allMappings.find(
    (m) =>
      m.concept_id.toLowerCase().includes(term.toLowerCase()) ||
      m.table_name.toLowerCase().includes(term.toLowerCase()) ||
      m.synonyms.some((s) => s.toLowerCase().includes(term.toLowerCase())),
  );

  if (!matching) {
    logger.warn('[MappingResolver] Concept not found', {
      term,
      datasourceId,
      suggestion: 'Run mapSemanticOntology to generate mappings',
    });
    return null;
  }

  logger.info('[MappingResolver] Concept resolved', {
    term,
    conceptId: matching.concept_id,
    table: `${matching.table_schema}.${matching.table_name}`,
    confidence: matching.confidence,
  });

  return {
    concept_id: matching.concept_id,
    table_schema: matching.table_schema,
    table_name: matching.table_name,
    confidence: matching.confidence,
  };
}

export async function resolveProperty(
  datasourceId: string,
  tableSchema: string,
  tableName: string,
  propertyTerm: string,
  ontologyVersion: string = '1.0.0',
): Promise<{ column_name: string; property_id: string } | null> {
  const logger = await getLogger();

  logger.debug('[MappingResolver] Resolving property', {
    datasourceId,
    tableSchema,
    tableName,
    propertyTerm,
  });

  const allMappings = await loadMappings(datasourceId, ontologyVersion);
  const tableMapping = allMappings.find(
    (m) => m.table_schema === tableSchema && m.table_name === tableName,
  );

  if (!tableMapping) {
    logger.warn('[MappingResolver] Table mapping not found', {
      tableSchema,
      tableName,
      datasourceId,
    });
    return null;
  }

  const columnMapping = tableMapping.column_mappings.find(
    (cm) =>
      cm.property_id.toLowerCase().includes(propertyTerm.toLowerCase()) ||
      cm.column_name.toLowerCase().includes(propertyTerm.toLowerCase()),
  );

  if (!columnMapping) {
    logger.warn('[MappingResolver] Property not found', {
      propertyTerm,
      tableSchema,
      tableName,
    });
    return null;
  }

  logger.info('[MappingResolver] Property resolved', {
    propertyTerm,
    propertyId: columnMapping.property_id,
    columnName: columnMapping.column_name,
  });

  return {
    column_name: columnMapping.column_name,
    property_id: columnMapping.property_id,
  };
}

/**
 * Resolve concept with validation against actual datasource schema.
 * Ensures the resolved table/column names exist in the schema.
 */
export async function resolveConceptWithValidation(
  datasourceId: string,
  term: string,
  ontologyVersion: string,
  metadata: DatasourceMetadata,
): Promise<ConceptResolution | null> {
  const logger = await getLogger();

  logger.info('[MappingResolver] Resolving concept with validation', {
    term,
    datasourceId,
    ontologyVersion,
  });

  // Resolve concept first
  const resolved = await resolveConcept(datasourceId, term, ontologyVersion);
  if (!resolved) {
    return null;
  }

  // Validate against actual schema
  const table = metadata.tables.find(
    (t) => t.schema === resolved.table_schema && t.name === resolved.table_name,
  );

  if (!table) {
    logger.warn('[MappingResolver] Resolved table not found in schema', {
      table: `${resolved.table_schema}.${resolved.table_name}`,
      availableTables: metadata.tables.map((t) => `${t.schema}.${t.name}`).slice(0, 5),
    });
    return null;
  }

  logger.info('[MappingResolver] Concept validated against schema', {
    term,
    conceptId: resolved.concept_id,
    table: `${resolved.table_schema}.${resolved.table_name}`,
    validated: true,
  });

  // Return with actual schema validation
  return {
    ...resolved,
    validated: true,
    actualTableName: table.name,
    actualSchema: table.schema,
  };
}
