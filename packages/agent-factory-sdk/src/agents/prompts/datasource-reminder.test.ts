import { describe, expect, it } from 'vitest';

import { buildDatasourceReminder } from './datasource-reminder';

describe('buildDatasourceReminder', () => {
  it('includes per-provider SQL dialect rules when known', () => {
    const out = buildDatasourceReminder([
      {
        id: 'ds1',
        name: 'pg',
        provider: 'postgresql',
        driver: 'postgresql.default',
      },
      { id: 'ds2', name: 'mysql', provider: 'mysql', driver: 'mysql.default' },
      {
        id: 'ds3',
        name: 'duck',
        provider: 'duckdb',
        driver: 'duckdb.default',
      },
    ]);

    expect(out).toContain('SQL DIALECT RULES');
    expect(out).toContain('PostgreSQL (postgresql)');
    expect(out).toContain('MySQL (mysql)');
    expect(out).toContain('DuckDB (duckdb)');
  });

  it('omits rules for unknown providers', () => {
    const out = buildDatasourceReminder([
      { id: 'ds1', name: 'x', provider: 'some-weird', driver: 'x' },
    ]);
    expect(out).not.toContain('SQL DIALECT RULES');
  });
});
