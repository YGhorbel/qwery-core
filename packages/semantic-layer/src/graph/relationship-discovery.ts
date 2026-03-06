import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { DatasourceMetadata, Table, Column } from '@qwery/domain/entities';
import type { Ontology } from '../models/ontology.schema';
import type { PredictedRelationship } from '../mapping/link-prediction';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface DiscoveredRelationship {
  sourceConcept: string;
  targetConcept: string;
  sourceTable: string;
  targetTable: string;
  sourceColumn: string;
  targetColumn: string;
  relationshipType: 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many';
  confidence: number;
  factors: {
    nameSimilarity: number;
    typeMatch: number;
    valuePattern?: number;
    statistical: number;
    semantic: number;
  };
}

export interface RelationshipDiscoveryOptions {
  sampleDataLimit?: number;
  confidenceThreshold?: number;
  enableValueAnalysis?: boolean;
  enableSemanticAnalysis?: boolean;
}

/**
 * Multi-factor relationship discovery based on LOM paper.
 * Discovers implicit relationships beyond foreign keys.
 */
export async function discoverRelationships(
  metadata: DatasourceMetadata,
  ontology: Ontology,
  tableMappings: Array<{
    concept_id: string;
    table_schema: string;
    table_name: string;
  }>,
  options: RelationshipDiscoveryOptions = {},
): Promise<DiscoveredRelationship[]> {
  const logger = await getLogger();
  const {
    sampleDataLimit = 1000,
    confidenceThreshold = 0.6,
    enableValueAnalysis = false,
    enableSemanticAnalysis = false,
  } = options;

  logger.info('[RelationshipDiscovery] Starting multi-factor relationship discovery', {
    tablesCount: metadata.tables.length,
    conceptsCount: ontology.ontology.concepts.length,
    tableMappingsCount: tableMappings.length,
    confidenceThreshold,
  });

  const discovered: DiscoveredRelationship[] = [];
  const conceptToTableMap = new Map<string, { schema: string; name: string }>();

  // Build concept to table mapping
  for (const mapping of tableMappings) {
    conceptToTableMap.set(mapping.concept_id, {
      schema: mapping.table_schema,
      name: mapping.table_name,
    });
  }

  // Analyze all pairs of tables
  for (let i = 0; i < metadata.tables.length; i++) {
    const sourceTable = metadata.tables[i]!;
    const sourceConcept = tableMappings.find(
      (m) => m.table_schema === sourceTable.schema && m.table_name === sourceTable.name,
    )?.concept_id;

    if (!sourceConcept) {
      continue;
    }

    for (let j = i + 1; j < metadata.tables.length; j++) {
      const targetTable = metadata.tables[j]!;
      const targetConcept = tableMappings.find(
        (m) => m.table_schema === targetTable.schema && m.table_name === targetTable.name,
      )?.concept_id;

      if (!targetConcept || sourceConcept === targetConcept) {
        continue;
      }

      // Check if relationship already exists in ontology
      const sourceConceptObj = ontology.ontology.concepts.find((c) => c.id === sourceConcept);
      const existingRel = sourceConceptObj?.relationships?.find((r) => r.target === targetConcept);
      if (existingRel) {
        continue;
      }

      // Analyze columns for potential relationships
      const sourceColumns = metadata.columns.filter(
        (c) => c.schema === sourceTable.schema && c.table === sourceTable.name,
      );
      const targetColumns = metadata.columns.filter(
        (c) => c.schema === targetTable.schema && c.table === targetTable.name,
      );

      // Find potential relationship columns
      for (const sourceCol of sourceColumns) {
        for (const targetCol of targetColumns) {
          const score = await scoreRelationship(
            sourceTable,
            targetTable,
            sourceCol,
            targetCol,
            enableValueAnalysis,
            enableSemanticAnalysis,
          );

          if (score.total >= confidenceThreshold) {
            const relationshipType = inferRelationshipType(
              sourceTable,
              targetTable,
              sourceCol,
              targetCol,
              metadata,
            );

            discovered.push({
              sourceConcept,
              targetConcept,
              sourceTable: `${sourceTable.schema}.${sourceTable.name}`,
              targetTable: `${targetTable.schema}.${targetTable.name}`,
              sourceColumn: sourceCol.name,
              targetColumn: targetCol.name,
              relationshipType,
              confidence: score.total,
              factors: score.factors,
            });
          }
        }
      }
    }
  }

  logger.info('[RelationshipDiscovery] Discovery complete', {
    discoveredCount: discovered.length,
    aboveThreshold: discovered.filter((d) => d.confidence >= confidenceThreshold).length,
  });

  return discovered.sort((a, b) => b.confidence - a.confidence);
}

interface RelationshipScore {
  total: number;
  factors: {
    nameSimilarity: number;
    typeMatch: number;
    valuePattern?: number;
    statistical: number;
    semantic: number;
  };
}

async function scoreRelationship(
  sourceTable: Table,
  targetTable: Table,
  sourceColumn: Column,
  targetColumn: Column,
  enableValueAnalysis: boolean,
  enableSemanticAnalysis: boolean,
): Promise<RelationshipScore> {
  const factors = {
    nameSimilarity: 0.0,
    typeMatch: 0.0,
    valuePattern: 0.0,
    statistical: 0.0,
    semantic: 0.0,
  };

  // Factor 1: Column name similarity (0.3 weight)
  factors.nameSimilarity = calculateNameSimilarity(sourceColumn.name, targetColumn.name, targetTable.name);

  // Factor 2: Data type matching (0.2 weight)
  factors.typeMatch = calculateTypeMatch(sourceColumn.data_type, targetColumn.data_type);

  // Factor 3: Value pattern analysis (0.3 weight) - if enabled
  if (enableValueAnalysis) {
    try {
      const { analyzeValuePatterns } = await import('./value-pattern-analyzer');
      // Note: This requires driver instance, which would need to be passed in
      // For now, we'll skip this if driver is not available
      // In full implementation, driver instance should be passed to discoverRelationships
      factors.valuePattern = 0.0; // Placeholder - requires driver instance
    } catch (error) {
      factors.valuePattern = 0.0;
    }
  }

  // Factor 4: Statistical analysis (0.1 weight)
  factors.statistical = calculateStatisticalMatch(sourceColumn, targetColumn);

  // Factor 5: Semantic similarity (0.1 weight) - if enabled
  if (enableSemanticAnalysis) {
    try {
      factors.semantic = await calculateSemanticSimilarity(
        sourceTable,
        targetTable,
        sourceColumn,
        targetColumn,
      );
    } catch (error) {
      factors.semantic = 0.0;
    }
  }

  // Calculate weighted total
  const total =
    factors.nameSimilarity * 0.3 +
    factors.typeMatch * 0.2 +
    (factors.valuePattern ?? 0) * 0.3 +
    factors.statistical * 0.1 +
    factors.semantic * 0.1;

  return {
    total: Math.min(1.0, total),
    factors,
  };
}

function calculateNameSimilarity(
  sourceColumnName: string,
  targetColumnName: string,
  targetTableName: string,
): number {
  const sourceLower = sourceColumnName.toLowerCase();
  const targetLower = targetColumnName.toLowerCase();
  const tableLower = targetTableName.toLowerCase();

  // Exact match
  if (sourceLower === targetLower) {
    return 1.0;
  }

  // Pattern: {table}_id matches id
  if (sourceLower.includes('_id') && targetLower === 'id') {
    const prefix = sourceLower.replace('_id', '');
    if (tableLower.includes(prefix) || prefix.includes(tableLower.substring(0, 3))) {
      return 0.9;
    }
  }

  // Pattern: id matches {table}_id
  if (sourceLower === 'id' && targetLower.includes('_id')) {
    const prefix = targetLower.replace('_id', '');
    if (tableLower.includes(prefix) || prefix.includes(tableLower.substring(0, 3))) {
      return 0.9;
    }
  }

  // Contains match
  if (sourceLower.includes(targetLower) || targetLower.includes(sourceLower)) {
    return 0.7;
  }

  // Levenshtein distance
  const distance = levenshteinDistance(sourceLower, targetLower);
  const maxLen = Math.max(sourceLower.length, targetLower.length);
  const similarity = 1 - distance / maxLen;

  return Math.max(0, similarity * 0.6);
}

function calculateTypeMatch(sourceType: string, targetType: string): number {
  const sourceLower = sourceType.toLowerCase();
  const targetLower = targetType.toLowerCase();

  // Exact match
  if (sourceLower === targetLower) {
    return 1.0;
  }

  // Both are integers
  if (
    (sourceLower.includes('int') || sourceLower.includes('serial')) &&
    (targetLower.includes('int') || targetLower.includes('serial'))
  ) {
    return 0.9;
  }

  // Both are numeric
  if (
    (sourceLower.includes('numeric') || sourceLower.includes('decimal') || sourceLower.includes('float')) &&
    (targetLower.includes('numeric') || targetLower.includes('decimal') || targetLower.includes('float'))
  ) {
    return 0.8;
  }

  // Both are UUIDs
  if (sourceLower.includes('uuid') && targetLower.includes('uuid')) {
    return 1.0;
  }

  // Both are strings
  if (
    (sourceLower.includes('varchar') || sourceLower.includes('text') || sourceLower.includes('char')) &&
    (targetLower.includes('varchar') || targetLower.includes('text') || targetLower.includes('char'))
  ) {
    return 0.7;
  }

  return 0.0;
}

function calculateStatisticalMatch(sourceColumn: Column, targetColumn: Column): number {
  let score = 0.0;

  // Both are unique (likely primary/foreign key)
  if (sourceColumn.is_unique && targetColumn.is_unique) {
    score += 0.5;
  }

  // Source is unique, target is not (foreign key pattern)
  if (sourceColumn.is_unique && !targetColumn.is_unique) {
    score += 0.3;
  }

  // Both are not nullable (stronger relationship)
  if (!sourceColumn.is_nullable && !targetColumn.is_nullable) {
    score += 0.2;
  }

  return Math.min(1.0, score);
}

function inferRelationshipType(
  sourceTable: Table,
  targetTable: Table,
  sourceColumn: Column,
  targetColumn: Column,
  metadata: DatasourceMetadata,
): 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many' {
  // Check if source column is unique (likely belongs_to)
  if (sourceColumn.is_unique) {
    return 'belongs_to';
  }

  // Check if target column is unique (likely has_many)
  if (targetColumn.is_unique) {
    return 'has_many';
  }

  // Default to has_many for foreign key patterns
  if (sourceColumn.name.toLowerCase().includes('_id')) {
    return 'belongs_to';
  }

  return 'has_many';
}

function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1,
          matrix[i]![j - 1]! + 1,
          matrix[i - 1]![j]! + 1,
        );
      }
    }
  }

  return matrix[str2.length]![str1.length]!;
}

/**
 * Calculate semantic similarity between columns using LLM.
 */
async function calculateSemanticSimilarity(
  sourceTable: Table,
  targetTable: Table,
  sourceColumn: Column,
  targetColumn: Column,
): Promise<number> {
  // This would use LLM to analyze semantic similarity
  // For now, return a simple heuristic based on column names
  const sourceLower = sourceColumn.name.toLowerCase();
  const targetLower = targetColumn.name.toLowerCase();

  // Check for common patterns
  if (sourceLower === targetLower) {
    return 1.0;
  }

  // Check for ID patterns
  if (
    (sourceLower.includes('id') && targetLower.includes('id')) ||
    (sourceLower.includes('_id') && targetLower === 'id')
  ) {
    return 0.8;
  }

  // Check for name patterns
  if (
    (sourceLower.includes('name') && targetLower.includes('name')) ||
    (sourceLower.includes('title') && targetLower.includes('title'))
  ) {
    return 0.7;
  }

  // Check for date patterns
  if (
    (sourceLower.includes('date') && targetLower.includes('date')) ||
    (sourceLower.includes('time') && targetLower.includes('time'))
  ) {
    return 0.6;
  }

  return 0.0;
}
