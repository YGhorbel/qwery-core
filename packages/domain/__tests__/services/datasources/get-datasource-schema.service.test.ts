import { describe, expect, it, vi } from 'vitest';
import {
  DatasourceKind,
  type Datasource,
  type DatasourceMetadata,
} from '../../../src/entities';
import { GetDatasourceSchemaService } from '../../../src/services/datasources/get-datasource-schema.service';

describe('GetDatasourceSchemaService', () => {
  const datasource: Datasource = {
    id: 'ds-1',
    projectId: 'proj-1',
    name: 'main-db',
    description: 'test',
    slug: 'main-db',
    datasource_provider: 'duckdb',
    datasource_driver: 'duckdb',
    datasource_kind: DatasourceKind.EMBEDDED,
    config: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: 'user-1',
    updatedBy: 'user-1',
    isPublic: false,
  };

  const metadata: DatasourceMetadata = {
    version: '0.0.1',
    driver: 'duckdb',
    schemas: [{ id: 1, name: 'main', owner: 'unknown' }],
    tables: [
      {
        id: 1,
        schema: 'main',
        name: 'users',
        rls_enabled: false,
        rls_forced: false,
        bytes: 0,
        size: '0',
        live_rows_estimate: 0,
        dead_rows_estimate: 0,
        comment: null,
        primary_keys: [],
        relationships: [],
      },
    ],
    columns: [
      {
        id: 'main.users.id',
        table_id: 1,
        schema: 'main',
        table: 'users',
        name: 'id',
        ordinal_position: 1,
        data_type: 'INTEGER',
        format: 'INTEGER',
        is_identity: false,
        identity_generation: null,
        is_generated: false,
        is_nullable: false,
        is_updatable: true,
        is_unique: false,
        check: null,
        default_value: null,
        enums: [],
        comment: null,
      },
    ],
  };

  it('returns Result.ok for compact mode', async () => {
    const datasourceRepository = {
      findById: vi.fn().mockResolvedValue(datasource),
    };
    const metadataRepository = {
      getMetadata: vi.fn().mockResolvedValue(metadata),
    };
    const compactTransformer = {
      execute: vi.fn().mockResolvedValue({
        schemas: [
          {
            name: 'main',
            tables: [
              {
                name: 'users',
                columns: [{ name: 'id', type: 'INTEGER' }],
              },
            ],
          },
        ],
      }),
    };

    const service = new GetDatasourceSchemaService(
      datasourceRepository as never,
      metadataRepository as never,
      compactTransformer as never,
    );

    const result = await service.execute({
      datasourceId: 'ds-1',
      mode: 'compact',
    });

    expect(result.success).toBe(true);
    expect(result.value?.mode).toBe('compact');
  });

  it('returns Result.fail when datasource is missing', async () => {
    const service = new GetDatasourceSchemaService(
      { findById: vi.fn().mockResolvedValue(null) } as never,
      { getMetadata: vi.fn() } as never,
      { execute: vi.fn() } as never,
    );

    const result = await service.execute({ datasourceId: 'missing' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DATASOURCE_NOT_FOUND');
  });

  it('returns Result.fail when metadata loading fails', async () => {
    const service = new GetDatasourceSchemaService(
      { findById: vi.fn().mockResolvedValue(datasource) } as never,
      {
        getMetadata: vi.fn().mockRejectedValue(new Error('driver failed')),
      } as never,
      { execute: vi.fn() } as never,
    );

    const result = await service.execute({ datasourceId: 'ds-1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SCHEMA_METADATA_UNAVAILABLE');
    expect(result.error?.message).toBe('driver failed');
  });
});
