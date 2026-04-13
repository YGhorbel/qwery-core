import type {
  IDataSourceDriver,
  DatasourceExtension,
} from '@qwery/extensions-sdk';
import { ExtensionsRegistry, ExtensionScope } from '@qwery/extensions-sdk';
import { getDriverInstance } from '@qwery/extensions-loader';
import { getLogger } from '@qwery/shared/logger';

import { adaptMetadataToDiscoveredSchema } from './adapters/metadata.adapter';
import type { ColumnStats, DiscoveredSchema, SampleData } from './types';

export class DiscoveryService {
  async discoverSchema(
    datasourceId: string,
    datasourceProvider: string,
    driverId: string,
    config: Record<string, unknown>,
  ): Promise<DiscoveredSchema> {
    const driver = await this.getDriver(driverId, config);
    const metadata = await driver.metadata();

    return adaptMetadataToDiscoveredSchema(
      datasourceId,
      datasourceProvider,
      metadata,
    );
  }

  async getSampleData(
    driverId: string,
    config: Record<string, unknown>,
    tableRef: { schema: string; table: string },
    limit = 5,
  ): Promise<SampleData> {
    const driver = await this.getDriver(driverId, config);
    const sql = `SELECT * FROM "${tableRef.schema}"."${tableRef.table}" LIMIT ${limit}`;
    const result = await driver.query(sql);

    return {
      columns: result.columns.map((c) => c.name),
      rows: result.rows.map((row) => result.columns.map((c) => row[c.name])),
    };
  }

  async getColumnStats(
    driverId: string,
    config: Record<string, unknown>,
    columnRef: { schema: string; table: string; column: string },
  ): Promise<ColumnStats> {
    const driver = await this.getDriver(driverId, config);
    const { schema, table, column } = columnRef;
    const quotedRef = `"${schema}"."${table}"."${column}"`;

    const sql = `
      SELECT
        COUNT(*) AS total_count,
        COUNT(*) FILTER (WHERE ${quotedRef} IS NULL) AS null_count,
        COUNT(DISTINCT ${quotedRef}) AS distinct_count
      FROM "${schema}"."${table}"
    `;

    const result = await driver.query(sql);
    const row = result.rows[0] ?? {};

    const sampleSql = `
      SELECT DISTINCT ${quotedRef} AS val
      FROM "${schema}"."${table}"
      WHERE ${quotedRef} IS NOT NULL
      LIMIT 10
    `;
    const sampleResult = await driver.query(sampleSql);

    return {
      totalCount: Number(row['total_count'] ?? 0),
      nullCount: Number(row['null_count'] ?? 0),
      distinctCount: Number(row['distinct_count'] ?? 0),
      sampleValues: sampleResult.rows.map((r) => r['val']),
    };
  }

  async getDistinctColumnValues(
    driverId: string,
    config: Record<string, unknown>,
    columnRef: { schema: string; table: string; column: string },
    limit = 10,
  ): Promise<unknown[]> {
    const driver = await this.getDriver(driverId, config);
    const { schema, table, column } = columnRef;
    const sql = `
      SELECT DISTINCT "${column}" AS val
      FROM "${schema}"."${table}"
      WHERE "${column}" IS NOT NULL
      LIMIT ${limit}
    `;
    const result = await driver.query(sql);
    return result.rows.map((r) => r['val']);
  }

  async getColumnValueOverlap(
    driverId: string,
    config: Record<string, unknown>,
    from: { schema: string; table: string; column: string },
    to: { schema: string; table: string; column: string },
    sampleSize = 200,
  ): Promise<number> {
    const driver = await this.getDriver(driverId, config);
    const sql = `
      WITH child_sample AS (
        SELECT DISTINCT "${from.column}" AS val
        FROM "${from.schema}"."${from.table}"
        WHERE "${from.column}" IS NOT NULL
        LIMIT ${sampleSize}
      )
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM "${to.schema}"."${to.table}"
          WHERE "${to.column}" = child_sample.val
        ) THEN 1 ELSE 0 END) AS matched
      FROM child_sample
    `;
    const result = await driver.query(sql);
    const row = result.rows[0] ?? {};
    const total = Number(row['total'] ?? 0);
    const matched = Number(row['matched'] ?? 0);
    return total === 0 ? 0 : matched / total;
  }

  async executeQuery(
    driverId: string,
    config: Record<string, unknown>,
    sql: string,
    maxRows = 500,
  ): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
    const driver = await this.getDriver(driverId, config);
    const result = await driver.query(sql);
    const columns = result.columns.map((c) => c.name);
    const rows = result.rows.slice(0, maxRows).map((row) => {
      const out: Record<string, unknown> = {};
      for (const col of result.columns) out[col.name] = row[col.name];
      return out;
    });
    return { columns, rows };
  }

  private async getDriver(
    driverId: string,
    config: Record<string, unknown>,
  ): Promise<IDataSourceDriver> {
    const extensions = ExtensionsRegistry.list<DatasourceExtension>(
      ExtensionScope.DATASOURCE,
    );

    let driverExt: DatasourceExtension['drivers'][0] | undefined;
    for (const ext of extensions) {
      driverExt = ext.drivers.find((d) => d.id === driverId);
      if (driverExt) break;
    }

    if (!driverExt) {
      const logger = await getLogger();
      logger.warn({ driverId }, 'semantic-layer: driver not found in registry');
      throw new Error(`Driver "${driverId}" not found in extensions registry`);
    }

    return getDriverInstance(driverExt, { config });
  }
}

export const discoveryService = new DiscoveryService();
