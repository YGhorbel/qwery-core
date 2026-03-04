import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '@qwery/domain/repositories';
import { GetSchemaTool } from '../../src/tools/get-schema';
import { GetSchemaDetailedTool } from '../../src/tools/get-schema-detailed';
import * as schemaToolsUtils from '../../src/tools/schema/schema-tools.utils';

const debug = vi.fn();

vi.mock('@qwery/shared/logger', () => ({
  getLogger: vi.fn(async () => ({
    debug,
  })),
}));

function createToolContext(repositories: Repositories) {
  return {
    conversationId: 'conv-1',
    agentId: 'query',
    abort: new AbortController().signal,
    extra: {
      repositories,
      attachedDatasources: ['ds-1'],
    },
    messages: [],
    ask: vi.fn(),
    metadata: vi.fn(),
  };
}

describe('schema tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.QWERY_GET_SCHEMA_MODE;
    vi.restoreAllMocks();
  });

  it('uses compact mode by default in getSchema', async () => {
    const repositories = {
      datasource: {
        findById: vi.fn().mockResolvedValue({ id: 'ds-1' }),
      },
    } as unknown as Repositories;

    const execute = vi.fn().mockResolvedValue({
      success: true,
      value: {
        mode: 'compact',
        schema: {
          schemas: [
            {
              name: 'public',
              tables: [
                {
                  name: 'orders',
                  columns: [{ name: 'id', type: 'INTEGER' }],
                },
              ],
            },
          ],
        },
      },
    });

    vi.spyOn(schemaToolsUtils, 'createDatasourceSchemaService').mockReturnValue(
      {
        execute,
      } as never,
    );

    const tool = GetSchemaTool as {
      execute: (
        args: Record<string, never>,
        ctx: ReturnType<typeof createToolContext>,
      ) => Promise<unknown>;
    };

    const output = await tool.execute({}, createToolContext(repositories));

    expect(execute).toHaveBeenCalledWith({
      datasourceId: 'ds-1',
      mode: 'compact',
    });
    expect(output).toEqual({
      schema: {
        schemas: [
          {
            name: 'public',
            tables: [
              {
                name: 'orders',
                columns: [{ name: 'id', type: 'INTEGER' }],
              },
            ],
          },
        ],
      },
    });
  });

  it('respects legacy mode flag in getSchema', async () => {
    process.env.QWERY_GET_SCHEMA_MODE = 'legacy';

    const repositories = {
      datasource: {
        findById: vi.fn().mockResolvedValue({ id: 'ds-1' }),
      },
    } as unknown as Repositories;

    const execute = vi.fn().mockResolvedValue({
      success: true,
      value: {
        mode: 'legacy',
        schema: {
          version: '0.0.1',
          driver: 'duckdb',
          schemas: [],
          tables: [
            {
              id: 1,
              schema: 'public',
              name: 'orders',
              rls_enabled: false,
              rls_forced: false,
              bytes: 123,
              size: '123 bytes',
              live_rows_estimate: 10,
              dead_rows_estimate: 0,
              comment: null,
              primary_keys: [],
              relationships: [],
            },
          ],
          columns: [],
        },
      },
    });

    vi.spyOn(schemaToolsUtils, 'createDatasourceSchemaService').mockReturnValue(
      {
        execute,
      } as never,
    );

    const tool = GetSchemaTool as {
      execute: (
        args: Record<string, never>,
        ctx: ReturnType<typeof createToolContext>,
      ) => Promise<unknown>;
    };

    const output = await tool.execute({}, createToolContext(repositories));

    expect(execute).toHaveBeenCalledWith({
      datasourceId: 'ds-1',
      mode: 'legacy',
    });
    expect(
      (output as { schema: { tables: Array<{ bytes: number }> } }).schema
        .tables[0]?.bytes,
    ).toBe(123);
  });

  it('always returns full metadata in getSchemaDetailed', async () => {
    process.env.QWERY_GET_SCHEMA_MODE = 'compact';

    const repositories = {
      datasource: {
        findById: vi.fn().mockResolvedValue({ id: 'ds-1' }),
      },
    } as unknown as Repositories;

    const execute = vi.fn().mockResolvedValue({
      success: true,
      value: {
        mode: 'legacy',
        schema: {
          version: '0.0.1',
          driver: 'duckdb',
          schemas: [],
          tables: [
            {
              id: 1,
              schema: 'public',
              name: 'orders',
              rls_enabled: false,
              rls_forced: false,
              bytes: 456,
              size: '456 bytes',
              live_rows_estimate: 20,
              dead_rows_estimate: 0,
              comment: null,
              primary_keys: [],
              relationships: [],
            },
          ],
          columns: [],
        },
      },
    });

    vi.spyOn(schemaToolsUtils, 'createDatasourceSchemaService').mockReturnValue(
      {
        execute,
      } as never,
    );

    const detailedTool = GetSchemaDetailedTool as {
      execute: (
        args: Record<string, never>,
        ctx: ReturnType<typeof createToolContext>,
      ) => Promise<unknown>;
    };

    const output = await detailedTool.execute(
      {},
      createToolContext(repositories),
    );

    expect(execute).toHaveBeenCalledWith({
      datasourceId: 'ds-1',
      mode: 'legacy',
    });
    expect(
      (output as { schema: { tables: Array<{ bytes: number }> } }).schema
        .tables[0]?.bytes,
    ).toBe(456);
  });

  it('defaults unknown mode values to compact', () => {
    process.env.QWERY_GET_SCHEMA_MODE = 'something-else';
    expect(schemaToolsUtils.resolveGetSchemaMode()).toBe('compact');
  });
});
