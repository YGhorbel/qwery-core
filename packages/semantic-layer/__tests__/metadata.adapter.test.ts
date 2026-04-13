import { describe, expect, it } from 'vitest';

import { adaptMetadataToDiscoveredSchema } from '../src/adapters/metadata.adapter';
import type { DatasourceMetadata } from '@qwery/extensions-sdk/metadata';

function makeMetadata(
  overrides: Partial<DatasourceMetadata> = {},
): DatasourceMetadata {
  return {
    version: '0.0.1',
    driver: 'postgresql',
    schemas: [{ id: 1, name: 'public', owner: 'postgres' }],
    tables: [
      {
        id: 1,
        schema: 'public',
        name: 'orders',
        rls_enabled: false,
        rls_forced: false,
        bytes: 0,
        size: '0',
        live_rows_estimate: 0,
        dead_rows_estimate: 0,
        comment: null,
        primary_keys: [
          { table_id: 1, name: 'id', schema: 'public', table_name: 'orders' },
        ],
        relationships: [
          {
            id: 1,
            constraint_name: 'orders_customer_id_fkey',
            source_schema: 'public',
            source_table_name: 'orders',
            source_column_name: 'customer_id',
            target_table_schema: 'public',
            target_table_name: 'customers',
            target_column_name: 'id',
          },
        ],
      } as unknown,
      {
        id: 2,
        schema: 'public',
        name: 'customers',
        rls_enabled: false,
        rls_forced: false,
        bytes: 0,
        size: '0',
        live_rows_estimate: 0,
        dead_rows_estimate: 0,
        comment: null,
        primary_keys: [
          {
            table_id: 2,
            name: 'id',
            schema: 'public',
            table_name: 'customers',
          },
        ],
        relationships: [],
      } as unknown,
    ],
    columns: [
      {
        id: 'public.orders.id',
        table_id: 1,
        schema: 'public',
        table: 'orders',
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
      {
        id: 'public.orders.customer_id',
        table_id: 1,
        schema: 'public',
        table: 'orders',
        name: 'customer_id',
        ordinal_position: 2,
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
      {
        id: 'public.customers.id',
        table_id: 2,
        schema: 'public',
        table: 'customers',
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
    ...overrides,
  } as unknown as DatasourceMetadata;
}

describe('adaptMetadataToDiscoveredSchema', () => {
  it('maps tables and columns correctly', () => {
    const result = adaptMetadataToDiscoveredSchema(
      'ds-1',
      'postgresql',
      makeMetadata(),
    );

    expect(result.datasourceId).toBe('ds-1');
    expect(result.datasourceProvider).toBe('postgresql');
    expect(result.tables).toHaveLength(2);

    const orders = result.tables.find((t) => t.name === 'orders');
    expect(orders).toBeDefined();
    expect(orders!.schema).toBe('public');
    expect(orders!.type).toBe('TABLE');
    expect(orders!.columns).toHaveLength(2);
  });

  it('marks primary key columns correctly', () => {
    const result = adaptMetadataToDiscoveredSchema(
      'ds-1',
      'postgresql',
      makeMetadata(),
    );
    const orders = result.tables.find((t) => t.name === 'orders')!;
    const idCol = orders.columns.find((c) => c.name === 'id')!;
    const fkCol = orders.columns.find((c) => c.name === 'customer_id')!;

    expect(idCol.isPrimaryKey).toBe(true);
    expect(fkCol.isPrimaryKey).toBe(false);
  });

  it('extracts foreign keys grouped by constraint name', () => {
    const result = adaptMetadataToDiscoveredSchema(
      'ds-1',
      'postgresql',
      makeMetadata(),
    );

    expect(result.foreignKeys).toHaveLength(1);
    expect(result.foreignKeys[0]).toMatchObject({
      constraintName: 'orders_customer_id_fkey',
      fromSchema: 'public',
      fromTable: 'orders',
      fromColumns: ['customer_id'],
      toSchema: 'public',
      toTable: 'customers',
      toColumns: ['id'],
    });
  });

  it('groups multi-column foreign keys under one entry', () => {
    const metadata = makeMetadata();
    // Add a second column to the same FK constraint
    (
      metadata.tables[0] as unknown as { relationships: unknown[] }
    ).relationships.push({
      id: 2,
      constraint_name: 'orders_customer_id_fkey',
      source_schema: 'public',
      source_table_name: 'orders',
      source_column_name: 'customer_region',
      target_table_schema: 'public',
      target_table_name: 'customers',
      target_column_name: 'region',
    });

    const result = adaptMetadataToDiscoveredSchema(
      'ds-1',
      'postgresql',
      metadata,
    );

    expect(result.foreignKeys).toHaveLength(1);
    expect(result.foreignKeys[0]!.fromColumns).toEqual([
      'customer_id',
      'customer_region',
    ]);
    expect(result.foreignKeys[0]!.toColumns).toEqual(['id', 'region']);
  });

  it('marks VIEW type when table name appears in metadata.views', () => {
    const metadata = makeMetadata();
    (metadata as unknown as { views: unknown[] }).views = [
      { schema: 'public', name: 'orders' },
    ];

    const result = adaptMetadataToDiscoveredSchema(
      'ds-1',
      'postgresql',
      metadata,
    );
    const orders = result.tables.find((t) => t.name === 'orders')!;

    expect(orders.type).toBe('VIEW');
  });

  it('returns empty foreignKeys when no relationships exist', () => {
    const metadata = makeMetadata();
    (metadata.tables as unknown as Array<{ relationships: unknown[] }>).forEach(
      (t) => {
        t.relationships = [];
      },
    );

    const result = adaptMetadataToDiscoveredSchema(
      'ds-1',
      'postgresql',
      metadata,
    );
    expect(result.foreignKeys).toHaveLength(0);
  });

  it('sets discoveredAt as a valid ISO string', () => {
    const before = new Date().toISOString();
    const result = adaptMetadataToDiscoveredSchema(
      'ds-1',
      'postgresql',
      makeMetadata(),
    );
    const after = new Date().toISOString();

    expect(result.discoveredAt >= before).toBe(true);
    expect(result.discoveredAt <= after).toBe(true);
  });
});
