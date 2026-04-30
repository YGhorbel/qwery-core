/**
 * Agent 06 — Semantic Validator
 * Runs test queries against the real database to validate each measure.
 * Uses the same driver interface as the rest of the system.
 */
import type { Datasource } from '@qwery/domain/entities';
import { ExtensionsRegistry, type DatasourceExtension } from '@qwery/extensions-sdk';
import { getDriverInstance } from '@qwery/extensions-loader';
import type { SemanticLayer, ValidationResult } from '../types.js';

async function getDriver(datasource: Datasource) {
  const extension = ExtensionsRegistry.get(datasource.datasource_provider) as
    | DatasourceExtension
    | undefined;
  if (!extension?.drivers?.length) {
    throw new Error(`No driver for provider: ${datasource.datasource_provider}`);
  }
  const nodeDriver =
    extension.drivers.find((d) => d.runtime === 'node') ?? extension.drivers[0]!;
  return getDriverInstance(nodeDriver, { config: datasource.config });
}

export async function runSemanticValidator(
  datasource: Datasource,
  semanticLayer: SemanticLayer,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const instance = await getDriver(datasource);

  try {
    for (const [fieldId, measure] of Object.entries(semanticLayer.measures ?? {})) {
      const filterClause =
        measure.filters.length > 0
          ? `WHERE ${measure.filters.join(' AND ')}`
          : '';

      // Test 1: measure returns a non-null value
      try {
        const result = await instance.query(
          `SELECT ${measure.sql} AS val FROM ${measure.table} ${filterClause} LIMIT 1`,
        );
        const firstRow = result.rows[0] as Record<string, unknown> | undefined;
        const val = firstRow?.['val'];

        if (val === null || val === undefined) {
          results.push({
            fieldId,
            status: 'warn',
            value: val,
            suggestion: 'Measure returned NULL — check filters or column existence.',
          });
        } else {
          // Test 2: check null percentage on the raw column (if extractable)
          const rawColMatch = measure.sql.match(/\((\w+)\)/);
          const rawCol = rawColMatch?.[1];
          let nullPct: number | undefined;

          if (rawCol) {
            try {
              const nullResult = await instance.query(
                `SELECT CAST(COUNT(*) FILTER (WHERE ${rawCol} IS NULL) AS FLOAT) / NULLIF(COUNT(*), 0) AS null_pct FROM ${measure.table}`,
              );
              const nullRow = nullResult.rows[0] as Record<string, unknown> | undefined;
              nullPct = typeof nullRow?.['null_pct'] === 'number' ? nullRow['null_pct'] : undefined;
            } catch {
              // Driver may not support FILTER syntax — skip
            }
          }

          results.push({
            fieldId,
            status: nullPct !== undefined && nullPct > 0.3 ? 'warn' : 'ok',
            value: val,
            nullPct,
            ...(nullPct !== undefined && nullPct > 0.3
              ? { suggestion: `${Math.round(nullPct * 100)}% null values — consider adding a null filter.` }
              : {}),
          });
        }
      } catch (err) {
        results.push({
          fieldId,
          status: 'fail',
          error: err instanceof Error ? err.message : String(err),
          suggestion: 'Query failed — check SQL expression and table/column names.',
        });
      }
    }
  } finally {
    if (typeof instance.close === 'function') {
      await instance.close();
    }
  }

  return results;
}
