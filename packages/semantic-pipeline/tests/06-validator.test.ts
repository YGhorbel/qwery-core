import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSemanticValidator } from '../src/agents/06-semantic-validator.js';
import { DatasourceKind } from '@qwery/domain/entities';
import type { Datasource } from '@qwery/domain/entities';
import type { SemanticLayer } from '../src/types.js';

const mockQuery = vi.fn();
const mockClose = vi.fn();

vi.mock('@qwery/extensions-sdk', () => ({
  ExtensionsRegistry: {
    get: () => ({
      drivers: [{ id: 'test.default', runtime: 'node', entry: './driver.js' }],
    }),
  },
}));

vi.mock('@qwery/extensions-loader', () => ({
  getDriverInstance: () =>
    Promise.resolve({ query: mockQuery, close: mockClose }),
}));

const mockDatasource: Datasource = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Test DB',
  description: 'Test datasource',
  slug: 'test-db',
  datasource_provider: 'postgresql',
  datasource_driver: 'postgresql.default',
  datasource_kind: DatasourceKind.REMOTE,
  config: {},
  projectId: '00000000-0000-0000-0000-000000000002',
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: '00000000-0000-0000-0000-000000000003',
  updatedBy: '00000000-0000-0000-0000-000000000003',
  isPublic: false,
};

const mockSemanticLayer: SemanticLayer = {
  measures: {
    'orders.total_revenue': {
      label: 'Total Revenue',
      description: 'Sum of sale price for completed orders',
      sql: 'SUM(sale_price)',
      filters: ["status = 'complete'"],
      format: 'currency_usd',
      table: 'orders',
      synonyms: ['revenue', 'sales'],
    },
  },
  dimensions: {},
  business_rules: {},
  joins: {},
};

describe('runSemanticValidator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks measure as ok when query returns a value', async () => {
    mockQuery.mockResolvedValue({ columns: ['val'], rows: [{ val: 12345.67 }] });

    const results = await runSemanticValidator(mockDatasource, mockSemanticLayer);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('ok');
    expect(results[0]?.value).toBe(12345.67);
    expect(mockClose).toHaveBeenCalled();
  });

  it('marks measure as warn when query returns null', async () => {
    mockQuery.mockResolvedValue({ columns: ['val'], rows: [{ val: null }] });

    const results = await runSemanticValidator(mockDatasource, mockSemanticLayer);

    expect(results[0]?.status).toBe('warn');
    expect(results[0]?.suggestion).toMatch(/NULL/);
  });

  it('marks measure as fail when query throws', async () => {
    mockQuery.mockRejectedValue(new Error('column "sale_price" does not exist'));

    const results = await runSemanticValidator(mockDatasource, mockSemanticLayer);

    expect(results[0]?.status).toBe('fail');
    expect(results[0]?.error).toMatch(/sale_price/);
  });

  it('closes driver instance even on error', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'));

    await runSemanticValidator(mockDatasource, mockSemanticLayer);

    expect(mockClose).toHaveBeenCalledOnce();
  });
});
