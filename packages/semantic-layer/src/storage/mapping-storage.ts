import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { MappingResult } from '../mapping/generator';
import { MinIOClient, getMinIOClient } from './minio-client';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface MappingStorage {
  loadMappings(datasourceId: string, version: string): Promise<MappingResult | null>;
  storeMappings(datasourceId: string, version: string, mappings: MappingResult): Promise<void>;
  mappingsExist(datasourceId: string, version: string): Promise<boolean>;
  getMappingsMetadata(datasourceId: string, version: string): Promise<{ lastModified?: Date; size?: number } | null>;
}

export class MinIOMappingStorage implements MappingStorage {
  private client: MinIOClient;

  constructor(client: MinIOClient) {
    this.client = client;
  }

  async loadMappings(datasourceId: string, version: string): Promise<MappingResult | null> {
    const logger = await getLogger();
    const path = `mappings/${datasourceId}/${version}/mappings.json`;

    logger.debug('[MappingStorage] Loading mappings from MinIO', {
      datasourceId,
      version,
      path,
    });

    const object = await this.client.getObject(path);
    if (!object) {
      logger.debug('[MappingStorage] Mappings not found in MinIO', {
        datasourceId,
        version,
        path,
      });
      return null;
    }

    try {
      const mappings = JSON.parse(object.content) as MappingResult;

      logger.info('[MappingStorage] Mappings loaded from MinIO', {
        datasourceId,
        version,
        tableMappingsCount: mappings.table_mappings.length,
      });

      return mappings;
    } catch (error) {
      logger.error('[MappingStorage] Failed to parse mappings from MinIO', {
        datasourceId,
        version,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async storeMappings(datasourceId: string, version: string, mappings: MappingResult): Promise<void> {
    const logger = await getLogger();
    const path = `mappings/${datasourceId}/${version}/mappings.json`;

    logger.debug('[MappingStorage] Storing mappings to MinIO', {
      datasourceId,
      version,
      path,
    });

    const jsonContent = JSON.stringify(mappings, null, 2);
    await this.client.putObject(path, jsonContent, 'application/json');

    logger.info('[MappingStorage] Mappings stored to MinIO', {
      datasourceId,
      version,
      tableMappingsCount: mappings.table_mappings.length,
    });
  }

  async mappingsExist(datasourceId: string, version: string): Promise<boolean> {
    const path = `mappings/${datasourceId}/${version}/mappings.json`;
    return this.client.objectExists(path);
  }

  async getMappingsMetadata(datasourceId: string, version: string): Promise<{ lastModified?: Date; size?: number } | null> {
    const path = `mappings/${datasourceId}/${version}/mappings.json`;
    return this.client.getObjectMetadata(path);
  }
}

export function getMappingStorage(): MappingStorage | null {
  const client = getMinIOClient();
  if (!client) {
    return null;
  }
  return new MinIOMappingStorage(client);
}
