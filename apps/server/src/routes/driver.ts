import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getDriverInstance } from '@qwery/extensions-loader';
import {
  ExtensionsRegistry,
  type DatasourceExtension,
} from '@qwery/extensions-sdk';
import { getLogger } from '@qwery/shared/logger';

const bodySchema = z.object({
  action: z.enum(['testConnection', 'metadata', 'query']),
  datasourceProvider: z.string(),
  driverId: z.string().optional(),
  config: z.record(z.string(), z.unknown()),
  sql: z.string().optional(),
});

export function createDriverRoutes() {
  const app = new Hono();

  app.post('/command', zValidator('json', bodySchema), async (c) => {
    const logger = await getLogger();
    const body = c.req.valid('json');
    const { action, datasourceProvider, driverId, config, sql } = body;

    const dsMeta = ExtensionsRegistry.get(datasourceProvider) as
      | DatasourceExtension
      | undefined;
    if (!dsMeta) {
      logger.error({ datasourceProvider, driverId }, 'Datasource not found');
      return c.json({ error: 'Datasource not found' }, 404);
    }

    const driver =
      dsMeta.drivers?.find((d) => d.id === driverId) ?? dsMeta.drivers?.[0];
    if (!driver) {
      logger.error({ datasourceProvider, driverId }, 'Driver not found');
      return c.json({ error: 'Driver not found' }, 404);
    }

    if (driver.runtime !== 'node') {
      logger.error(
        { datasourceProvider, driverId },
        'Driver is not node runtime for server execution',
      );
      return c.json(
        { error: 'Driver is not node runtime for server execution' },
        400,
      );
    }

    let instance: Awaited<ReturnType<typeof getDriverInstance>> | null = null;
    
    try {
      instance = await getDriverInstance(driver, {
        config,
      });

      switch (action) {
        case 'testConnection':
          await instance.testConnection();
          return c.json({
            success: true,
            data: { connected: true, message: 'ok' },
          });
        case 'metadata': {
          logger.info('[DriverRoute] Fetching metadata', {
            datasourceProvider,
            driverId,
          });
          const metadata = await instance.metadata();
          logger.info('[DriverRoute] Metadata fetched successfully', {
            datasourceProvider,
            tablesCount: metadata.tables.length,
            columnsCount: metadata.columns.length,
          });
          return c.json({
            success: true,
            data: metadata,
          });
        }
        case 'query': {
          if (!sql) {
            return c.json({ error: 'SQL is required for query action' }, 400);
          }
          const queryResult = await instance.query(sql);
          return c.json({
            success: true,
            data: queryResult,
          });
        }
        default:
          return c.json({ error: 'Unknown action' }, 400);
      }
    } catch (error) {
      logger.error(
        {
          error,
          action,
          datasourceProvider,
          driverId,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        'Error executing driver action',
      );
      
      // Clean up instance on error
      if (instance && typeof instance.close === 'function') {
        try {
          await instance.close();
        } catch (closeError) {
          logger.warn({ closeError }, 'Error closing driver instance');
        }
      }
      
      const message = formatError(error);
      
      // Provide more helpful error messages for timeout
      if (message.includes('timed out') || message.includes('timeout')) {
        return c.json(
          {
            error: `Connection timeout: ${message}. This may indicate network issues, slow database response, or the database is unreachable. Please check your connection settings and try again.`,
            timeout: true,
          },
          504, // Gateway Timeout
        );
      }
      
      return c.json({ error: message }, 500);
    }
  });

  return app;
}

function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    const inner = (error.errors || [])
      .map((e) => (e instanceof Error ? e.message : String(e)))
      .filter(Boolean)
      .join('; ');
    return inner || error.message || 'Aggregate driver error';
  }
  if (error instanceof Error) return error.message || error.toString();
  return String(error);
}
