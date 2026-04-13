import { describe, expect, it, vi, beforeEach } from 'vitest';

import { DiscoveryService } from '../src/discovery.service';

// Mock extensions loader
vi.mock('@qwery/extensions-loader', () => ({
  getDriverInstance: vi.fn(),
}));

// Mock extensions registry
vi.mock('@qwery/extensions-sdk', () => ({
  ExtensionsRegistry: {
    list: vi.fn(),
  },
  ExtensionScope: { DATASOURCE: 'datasource' },
}));

vi.mock('@qwery/shared/logger', () => ({
  getLogger: vi.fn().mockResolvedValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { getDriverInstance } from '@qwery/extensions-loader';
import { ExtensionsRegistry } from '@qwery/extensions-sdk';

const mockMetadata = {
  version: '0.0.1',
  driver: 'postgresql',
  schemas: [{ id: 1, name: 'public', owner: 'postgres' }],
  tables: [
    {
      id: 1,
      schema: 'public',
      name: 'users',
      primary_keys: [{ name: 'id' }],
      relationships: [],
    },
  ],
  columns: [
    {
      id: 'public.users.id',
      table_id: 1,
      schema: 'public',
      table: 'users',
      name: 'id',
      ordinal_position: 1,
      data_type: 'integer',
      format: 'int4',
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

const mockDriverExt = {
  id: 'postgresql.default',
  name: 'PostgreSQL',
  runtime: 'node',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ExtensionsRegistry.list).mockReturnValue([
    { id: 'postgresql', name: 'PostgreSQL', drivers: [mockDriverExt] },
  ] as ReturnType<typeof ExtensionsRegistry.list>);
});

describe('DiscoveryService.discoverSchema', () => {
  it('returns a DiscoveredSchema with correct datasourceId', async () => {
    const mockDriver = {
      metadata: vi.fn().mockResolvedValue(mockMetadata),
      query: vi.fn(),
      testConnection: vi.fn(),
    };
    vi.mocked(getDriverInstance).mockResolvedValue(mockDriver);

    const service = new DiscoveryService();
    const result = await service.discoverSchema(
      'ds-abc',
      'postgresql',
      'postgresql.default',
      { connectionUrl: 'postgresql://localhost/test' },
    );

    expect(result.datasourceId).toBe('ds-abc');
    expect(result.datasourceProvider).toBe('postgresql');
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.name).toBe('users');
  });

  it('throws when driver is not found in registry', async () => {
    vi.mocked(ExtensionsRegistry.list).mockReturnValue([]);

    const service = new DiscoveryService();
    await expect(
      service.discoverSchema('ds-abc', 'postgresql', 'unknown.driver', {}),
    ).rejects.toThrow('Driver "unknown.driver" not found');
  });
});

describe('DiscoveryService.getSampleData', () => {
  it('returns columns and rows from driver.query', async () => {
    const mockDriver = {
      metadata: vi.fn(),
      testConnection: vi.fn(),
      query: vi.fn().mockResolvedValue({
        columns: [{ name: 'id' }, { name: 'name' }],
        rows: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        stat: {
          rowsAffected: 2,
          rowsRead: 2,
          rowsWritten: 0,
          queryDurationMs: null,
        },
      }),
    };
    vi.mocked(getDriverInstance).mockResolvedValue(mockDriver);

    const service = new DiscoveryService();
    const result = await service.getSampleData(
      'postgresql.default',
      { connectionUrl: 'postgresql://localhost/test' },
      { schema: 'public', table: 'users' },
      2,
    );

    expect(result.columns).toEqual(['id', 'name']);
    expect(result.rows).toHaveLength(2);
    expect(mockDriver.query).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT 2'),
    );
  });
});

describe('DiscoveryService.getColumnStats', () => {
  it('returns stats from driver.query', async () => {
    const mockDriver = {
      metadata: vi.fn(),
      testConnection: vi.fn(),
      query: vi
        .fn()
        .mockResolvedValueOnce({
          columns: [],
          rows: [{ total_count: '100', null_count: '5', distinct_count: '80' }],
          stat: {
            rowsAffected: 1,
            rowsRead: 1,
            rowsWritten: 0,
            queryDurationMs: null,
          },
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'val' }],
          rows: [{ val: 'a' }, { val: 'b' }],
          stat: {
            rowsAffected: 2,
            rowsRead: 2,
            rowsWritten: 0,
            queryDurationMs: null,
          },
        }),
    };
    vi.mocked(getDriverInstance).mockResolvedValue(mockDriver);

    const service = new DiscoveryService();
    const result = await service.getColumnStats(
      'postgresql.default',
      { connectionUrl: 'postgresql://localhost/test' },
      { schema: 'public', table: 'users', column: 'status' },
    );

    expect(result.totalCount).toBe(100);
    expect(result.nullCount).toBe(5);
    expect(result.distinctCount).toBe(80);
    expect(result.sampleValues).toEqual(['a', 'b']);
  });
});
