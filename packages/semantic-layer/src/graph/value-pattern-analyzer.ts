import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Column } from '@qwery/domain/entities';
import type { DatasourceExtension } from '@qwery/extensions-sdk';
import { getDriverInstance } from '@qwery/extensions-loader';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface ValuePatternResult {
  overlap: number;
  patternMatch: number;
  correlation: number;
  total: number;
}

/**
 * Analyze actual data values to discover relationships.
 * Implements value pattern analysis factor from LOM paper.
 */
export async function analyzeValuePatterns(
  sourceColumn: Column,
  targetColumn: Column,
  sourceTable: { schema: string; name: string },
  targetTable: { schema: string; name: string },
  driverInstance: Awaited<ReturnType<typeof getDriverInstance>>,
  sampleLimit: number = 1000,
): Promise<ValuePatternResult> {
  const logger = await getLogger();

  try {
    // Extract sample data from both columns
    const sourceValues = await extractSampleValues(
      driverInstance,
      sourceTable.schema,
      sourceTable.name,
      sourceColumn.name,
      sampleLimit,
    );
    const targetValues = await extractSampleValues(
      driverInstance,
      targetTable.schema,
      targetTable.name,
      targetColumn.name,
      sampleLimit,
    );

    if (sourceValues.length === 0 || targetValues.length === 0) {
      logger.debug('[ValuePatternAnalyzer] Insufficient sample data', {
        sourceValuesCount: sourceValues.length,
        targetValuesCount: targetValues.length,
      });
      return {
        overlap: 0,
        patternMatch: 0,
        correlation: 0,
        total: 0,
      };
    }

    // Calculate overlap
    const overlap = calculateValueOverlap(sourceValues, targetValues);

    // Pattern matching
    const patternMatch = detectPatterns(sourceValues, targetValues);

    // Statistical correlation
    const correlation = calculateCorrelation(sourceValues, targetValues);

    // Combine scores (weighted)
    const total = overlap * 0.5 + patternMatch * 0.3 + correlation * 0.2;

    logger.debug('[ValuePatternAnalyzer] Value pattern analysis complete', {
      overlap: overlap.toFixed(3),
      patternMatch: patternMatch.toFixed(3),
      correlation: correlation.toFixed(3),
      total: total.toFixed(3),
    });

    return {
      overlap,
      patternMatch,
      correlation,
      total: Math.min(1.0, total),
    };
  } catch (error) {
    logger.warn('[ValuePatternAnalyzer] Value pattern analysis failed', {
      error: error instanceof Error ? error.message : String(error),
      sourceColumn: sourceColumn.name,
      targetColumn: targetColumn.name,
    });
    return {
      overlap: 0,
      patternMatch: 0,
      correlation: 0,
      total: 0,
    };
  }
}

/**
 * Extract sample values from a column.
 */
async function extractSampleValues(
  driverInstance: Awaited<ReturnType<typeof getDriverInstance>>,
  schema: string,
  table: string,
  column: string,
  limit: number,
): Promise<unknown[]> {
  try {
    const query = `SELECT DISTINCT ${column} FROM ${schema}.${table} WHERE ${column} IS NOT NULL LIMIT ${limit}`;
    const result = await driverInstance.execute(query);

    if (result && Array.isArray(result.rows)) {
      return result.rows.map((row) => row[0]).filter((val) => val !== null && val !== undefined);
    }

    return [];
  } catch (error) {
    // If query fails, return empty array
    return [];
  }
}

/**
 * Calculate value overlap between two columns.
 */
function calculateValueOverlap(sourceValues: unknown[], targetValues: unknown[]): number {
  if (sourceValues.length === 0 || targetValues.length === 0) {
    return 0;
  }

  const sourceSet = new Set(sourceValues.map(String));
  const targetSet = new Set(targetValues.map(String));

  let overlapCount = 0;
  for (const value of sourceSet) {
    if (targetSet.has(value)) {
      overlapCount++;
    }
  }

  // Jaccard similarity
  const unionSize = new Set([...sourceSet, ...targetSet]).size;
  if (unionSize === 0) {
    return 0;
  }

  return overlapCount / unionSize;
}

/**
 * Detect patterns in values (IDs, codes, references).
 */
function detectPatterns(sourceValues: unknown[], targetValues: unknown[]): number {
  if (sourceValues.length === 0 || targetValues.length === 0) {
    return 0;
  }

  const sourceStrings = sourceValues.map(String);
  const targetStrings = targetValues.map(String);

  // Check for ID pattern (numeric IDs)
  const sourceNumeric = sourceStrings.filter((v) => /^\d+$/.test(v));
  const targetNumeric = targetStrings.filter((v) => /^\d+$/.test(v));

  if (sourceNumeric.length > 0 && targetNumeric.length > 0) {
    const sourceNumericSet = new Set(sourceNumeric);
    const targetNumericSet = new Set(targetNumeric);
    let matchCount = 0;
    for (const val of sourceNumericSet) {
      if (targetNumericSet.has(val)) {
        matchCount++;
      }
    }
    if (matchCount > 0) {
      return Math.min(1.0, matchCount / Math.max(sourceNumericSet.size, targetNumericSet.size));
    }
  }

  // Check for UUID pattern
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const sourceUUIDs = sourceStrings.filter((v) => uuidPattern.test(v));
  const targetUUIDs = targetStrings.filter((v) => uuidPattern.test(v));

  if (sourceUUIDs.length > 0 && targetUUIDs.length > 0) {
    const sourceUUIDSet = new Set(sourceUUIDs);
    const targetUUIDSet = new Set(targetUUIDs);
    let matchCount = 0;
    for (const val of sourceUUIDSet) {
      if (targetUUIDSet.has(val)) {
        matchCount++;
      }
    }
    if (matchCount > 0) {
      return Math.min(1.0, matchCount / Math.max(sourceUUIDSet.size, targetUUIDSet.size));
    }
  }

  // Check for code pattern (alphanumeric codes)
  const codePattern = /^[A-Z0-9]{3,}$/i;
  const sourceCodes = sourceStrings.filter((v) => codePattern.test(v));
  const targetCodes = targetStrings.filter((v) => codePattern.test(v));

  if (sourceCodes.length > 0 && targetCodes.length > 0) {
    const sourceCodeSet = new Set(sourceCodes);
    const targetCodeSet = new Set(targetCodes);
    let matchCount = 0;
    for (const val of sourceCodeSet) {
      if (targetCodeSet.has(val)) {
        matchCount++;
      }
    }
    if (matchCount > 0) {
      return Math.min(1.0, matchCount / Math.max(sourceCodeSet.size, targetCodeSet.size));
    }
  }

  return 0;
}

/**
 * Calculate statistical correlation between value sets.
 */
function calculateCorrelation(sourceValues: unknown[], targetValues: unknown[]): number {
  if (sourceValues.length === 0 || targetValues.length === 0) {
    return 0;
  }

  // Co-occurrence analysis
  const sourceSet = new Set(sourceValues.map(String));
  const targetSet = new Set(targetValues.map(String));

  const intersection = new Set([...sourceSet].filter((x) => targetSet.has(x)));
  const union = new Set([...sourceSet, ...targetSet]);

  if (union.size === 0) {
    return 0;
  }

  // Jaccard coefficient
  return intersection.size / union.size;
}
