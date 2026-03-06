import type { MappingResult } from './generator';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export async function storeMappings(
  datasourceId: string,
  ontologyVersion: string,
  mappings: MappingResult,
): Promise<{
  tableMappingsCreated: number;
  columnMappingsCreated: number;
}> {
  const logger = await getLogger();
  const { getMinIOStore } = await import('../storage/minio-store');
  const { getRedisIndex } = await import('../index/redis-index');
  const minIOStore = getMinIOStore();
  const redisIndex = getRedisIndex();

  if (!minIOStore || !redisIndex) {
    throw new Error('MinIO store or Redis index not available');
  }

  const mappingStore = minIOStore.createMappingStore();
  await mappingStore.put(datasourceId, ontologyVersion, mappings);

  const s3Path = `mappings/${datasourceId}/${ontologyVersion}/mappings.json`;
  for (const tableMapping of mappings.table_mappings) {
    await redisIndex.setMappingIndex(datasourceId, tableMapping.concept_id, {
      s3Path,
      version: ontologyVersion,
    });
  }

  const tableMappingsCreated = mappings.table_mappings.length;
  const columnMappingsCreated = mappings.table_mappings.reduce(
    (sum, tm) => sum + tm.column_mappings.length,
    0,
  );

  logger.info('[MappingStore] Mappings stored', {
    datasourceId,
    ontologyVersion,
    tableMappingsCreated,
    columnMappingsCreated,
  });

  return { tableMappingsCreated, columnMappingsCreated };
}

export async function loadMappings(
  datasourceId: string,
  ontologyVersion: string = '1.0.0',
): Promise<Array<{
  id: string;
  table_schema: string;
  table_name: string;
  concept_id: string;
  confidence: number;
  synonyms: string[];
  column_mappings: Array<{
    column_name: string;
    property_id: string;
    confidence: number;
  }>;
}>> {
  const logger = await getLogger();
  const { getMinIOStore } = await import('../storage/minio-store');
  const minIOStore = getMinIOStore();

  if (!minIOStore) {
    logger.warn('[MappingStore] MinIO store not available');
    return [];
  }

  const mappingStore = minIOStore.createMappingStore();
  const mappings = await mappingStore.get(datasourceId, ontologyVersion);

  if (!mappings) {
    logger.debug('[MappingStore] Mappings not found', {
      datasourceId,
      ontologyVersion,
    });
    return [];
  }

  return mappings.table_mappings.map((tm, index) => ({
    id: `minio-${index}`,
    table_schema: tm.table_schema,
    table_name: tm.table_name,
    concept_id: tm.concept_id,
    confidence: tm.confidence,
    synonyms: tm.synonyms,
    column_mappings: tm.column_mappings,
  }));
}
