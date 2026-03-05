import { z } from 'zod';
import { Tool } from './tool';
import { getLogger } from '@qwery/shared/logger';
import { Repositories } from '@qwery/domain/repositories';
import {
  createDatasourceSchemaService,
  logSchemaPayloadStats,
} from './schema/schema-tools.utils';

const DESCRIPTION = `Get full datasource schema metadata with all details.
Use this only when detailed metadata is explicitly needed.`;

export const GetSchemaDetailedTool = Tool.define('getSchemaDetailed', {
  description: DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const logger = await getLogger();
    const { repositories, attachedDatasources } = ctx.extra as {
      repositories: Repositories;
      attachedDatasources: string[];
    };

    const datasourceId = attachedDatasources[0] ?? '';
    const schemaService = createDatasourceSchemaService(repositories);
    const result = await schemaService.execute({
      datasourceId,
      mode: 'legacy',
    });

    if (!result.success || !result.value) {
      const message =
        result.error?.message ?? 'Unable to fetch detailed schema';
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
      `[GetSchemaDetailedTool] Fetched detailed schema for datasource ${datasourceId}: ${allTables} table(s)`,
    );

    const payload = {
      schema: schemaOutput.schema,
      mode: schemaOutput.mode,
    };

    logSchemaPayloadStats(logger, 'GetSchemaDetailedTool', payload);

    return payload;
  },
});
