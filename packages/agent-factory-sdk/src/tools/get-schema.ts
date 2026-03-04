import { z } from 'zod';
import { Tool } from './tool';
import { getLogger } from '@qwery/shared/logger';
import { Repositories } from '@qwery/domain/repositories';
import {
  createDatasourceSchemaService,
  logSchemaPayloadStats,
  resolveGetSchemaMode,
} from './schema/schema-tools.utils';

const DESCRIPTION = `Get datasource schema optimized for NL-to-SQL planning.
Default mode returns compact schema (schema, table, column, type with minimal keys).
Set QWERY_GET_SCHEMA_MODE=legacy to return full metadata.`;

export const GetSchemaTool = Tool.define('getSchema', {
  description: DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const logger = await getLogger();
    const { repositories, attachedDatasources } = ctx.extra as {
      repositories: Repositories;
      attachedDatasources: string[];
    };

    const datasourceId = attachedDatasources[0] ?? '';
    const mode = resolveGetSchemaMode();

    logger.debug('[GetSchemaTool] Tool execution:', {
      datasourceId,
      attachedDatasources,
      mode,
    });

    const schemaService = createDatasourceSchemaService(repositories);
    const result = await schemaService.execute({
      datasourceId,
      mode,
    });

    if (!result.success || !result.value) {
      const message =
        result.error?.message ?? 'Unable to fetch datasource schema';
      throw new Error(message);
    }

    const schemaOutput = result.value;

    const allTables =
      'tables' in schemaOutput.schema
        ? schemaOutput.schema.tables.length
        : schemaOutput.schema.schemas.reduce(
            (count, schemaEntry) => count + schemaEntry.tables.length,
            0,
          );

    logger.debug(
      `[GetSchemaTool] Fetched schema for datasource ${datasourceId}: ${allTables} table(s)`,
    );

    const payload = {
      schema: schemaOutput.schema,
    };

    logSchemaPayloadStats(logger, 'GetSchemaTool', payload);

    return payload;
  },
});
