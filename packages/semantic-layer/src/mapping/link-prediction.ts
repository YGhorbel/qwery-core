import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { MappingResult } from './generator';
import type { Ontology } from '../models/ontology.schema';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface PredictedRelationship {
  sourceConcept: string;
  targetConcept: string;
  relationshipType: 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many';
  confidence: number;
  sourceTable: string;
  targetTable: string;
  sourceColumn: string;
  targetColumn: string;
}

export interface LinkPredictionConfig {
  confidenceThreshold?: number;
  rateLimitPerHour?: number;
  manualApprovalHook?: (relationships: PredictedRelationship[]) => Promise<PredictedRelationship[]>;
}

interface RateLimitTracker {
  datasourceId: string;
  edgesCreated: number;
  resetTime: number;
}

const rateLimitTrackers = new Map<string, RateLimitTracker>();

export async function predictRelationships(
  metadata: DatasourceMetadata,
  mappings: MappingResult,
  ontology: Ontology,
  datasourceId: string,
  config: LinkPredictionConfig = {},
): Promise<PredictedRelationship[]> {
  const logger = await getLogger();
  const confidenceThreshold = config.confidenceThreshold ?? 0.6;
  const rateLimitPerHour = config.rateLimitPerHour ?? 1000;

  logger.info('[LinkPrediction] Starting relationship prediction', {
    datasourceId,
    tablesCount: metadata.tables.length,
    mappingsCount: mappings.table_mappings.length,
    confidenceThreshold,
    rateLimitPerHour,
  });

  const tableToConceptMap = new Map<string, string>();
  for (const mapping of mappings.table_mappings) {
    const tableKey = `${mapping.table_schema}.${mapping.table_name}`;
    tableToConceptMap.set(tableKey, mapping.concept_id);
  }

  const conceptRelationships = new Map<string, Set<string>>();
  for (const concept of ontology.ontology.concepts) {
    for (const rel of concept.relationships || []) {
      if (!conceptRelationships.has(concept.id)) {
        conceptRelationships.set(concept.id, new Set());
      }
      conceptRelationships.get(concept.id)!.add(rel.target);
    }
  }

  const predicted: PredictedRelationship[] = [];

  for (const table of metadata.tables) {
    const sourceTableKey = `${table.schema}.${table.name}`;
    const sourceConcept = tableToConceptMap.get(sourceTableKey);

    if (!sourceConcept) {
      continue;
    }

    for (const relationship of table.relationships || []) {
      const targetTableKey = `${relationship.target_table_schema}.${relationship.target_table_name}`;
      const targetConcept = tableToConceptMap.get(targetTableKey);

      if (!targetConcept) {
        continue;
      }

      if (sourceConcept === targetConcept) {
        continue;
      }

      const existingRelationship = conceptRelationships
        .get(sourceConcept)
        ?.has(targetConcept);

      if (existingRelationship) {
        continue;
      }

      const confidence = calculateRelationshipConfidence(
        sourceConcept,
        targetConcept,
        relationship,
        ontology,
      );

      if (confidence < confidenceThreshold) {
        continue;
      }

      const relationshipType = inferRelationshipType(relationship, table, metadata);

      predicted.push({
        sourceConcept,
        targetConcept,
        relationshipType,
        confidence,
        sourceTable: sourceTableKey,
        targetTable: targetTableKey,
        sourceColumn: relationship.source_column_name,
        targetColumn: relationship.target_column_name,
      });
    }
  }

  logger.info('[LinkPrediction] Predicted relationships', {
    datasourceId,
    predictedCount: predicted.length,
    filteredCount: predicted.filter((p) => p.confidence >= confidenceThreshold).length,
  });

  const tracker = rateLimitTrackers.get(datasourceId);
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  if (!tracker || now > tracker.resetTime) {
    rateLimitTrackers.set(datasourceId, {
      datasourceId,
      edgesCreated: 0,
      resetTime: now + oneHour,
    });
  }

  const currentTracker = rateLimitTrackers.get(datasourceId)!;
  const remainingQuota = rateLimitPerHour - currentTracker.edgesCreated;

  if (remainingQuota <= 0) {
    logger.warn('[LinkPrediction] Rate limit exceeded', {
      datasourceId,
      rateLimitPerHour,
      edgesCreated: currentTracker.edgesCreated,
    });
    return [];
  }

  const filtered = predicted
    .filter((p) => p.confidence >= confidenceThreshold)
    .slice(0, remainingQuota)
    .sort((a, b) => b.confidence - a.confidence);

  currentTracker.edgesCreated += filtered.length;

  if (config.manualApprovalHook) {
    logger.info('[LinkPrediction] Running manual approval hook', {
      datasourceId,
      relationshipsCount: filtered.length,
    });
    const approved = await config.manualApprovalHook(filtered);
    logger.info('[LinkPrediction] Manual approval completed', {
      datasourceId,
      approvedCount: approved.length,
    });
    return approved;
  }

  return filtered;
}

function calculateRelationshipConfidence(
  sourceConcept: string,
  targetConcept: string,
  relationship: {
    source_table_name: string;
    target_table_name: string;
    source_column_name: string;
    target_column_name: string;
  },
  ontology: Ontology,
): number {
  let confidence = 0.5;

  const sourceConceptObj = ontology.ontology.concepts.find((c) => c.id === sourceConcept);
  const targetConceptObj = ontology.ontology.concepts.find((c) => c.id === targetConcept);

  if (!sourceConceptObj || !targetConceptObj) {
    return 0.0;
  }

  const sourceTableName = relationship.source_table_name.toLowerCase();
  const targetTableName = relationship.target_table_name.toLowerCase();
  const sourceConceptLabel = sourceConceptObj.label.toLowerCase();
  const targetConceptLabel = targetConceptObj.label.toLowerCase();

  if (sourceTableName.includes(sourceConceptLabel) || sourceConceptLabel.includes(sourceTableName)) {
    confidence += 0.1;
  }

  if (targetTableName.includes(targetConceptLabel) || targetConceptLabel.includes(targetTableName)) {
    confidence += 0.1;
  }

  const sourceColumnName = relationship.source_column_name.toLowerCase();
  const targetColumnName = relationship.target_column_name.toLowerCase();

  if (sourceColumnName.includes('id') || sourceColumnName.includes('key')) {
    confidence += 0.1;
  }

  if (targetColumnName.includes('id') || targetColumnName.includes('key')) {
    confidence += 0.1;
  }

  if (sourceColumnName === targetColumnName) {
    confidence += 0.1;
  }

  return Math.min(1.0, confidence);
}

function inferRelationshipType(
  relationship: {
    source_table_name: string;
    target_table_name: string;
    target_table_schema: string;
  },
  sourceTable: { name: string },
  metadata: DatasourceMetadata,
): 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many' {
  const targetTable = metadata.tables.find(
    (t) =>
      t.schema === relationship.target_table_schema &&
      t.name === relationship.target_table_name,
  );

  if (!targetTable) {
    return 'belongs_to';
  }

  const sourceHasMultipleRelationships = metadata.tables
    .find((t) => t.name === sourceTable.name)
    ?.relationships?.filter((r) => r.target_table_name === relationship.target_table_name).length || 0;

  const targetHasMultipleRelationships = targetTable.relationships?.filter(
    (r) => r.target_table_name === sourceTable.name,
  ).length || 0;

  if (sourceHasMultipleRelationships > 1 && targetHasMultipleRelationships > 1) {
    return 'many_to_many';
  }

  if (sourceHasMultipleRelationships > 1) {
    return 'has_many';
  }

  if (targetHasMultipleRelationships > 1) {
    return 'belongs_to';
  }

  return 'has_one';
}

export function resetRateLimit(datasourceId: string): void {
  rateLimitTrackers.delete(datasourceId);
}

export function getRateLimitStatus(datasourceId: string): {
  edgesCreated: number;
  remainingQuota: number;
  resetTime: number;
} | null {
  const tracker = rateLimitTrackers.get(datasourceId);
  if (!tracker) {
    return null;
  }

  const now = Date.now();
  if (now > tracker.resetTime) {
    return null;
  }

  const rateLimitPerHour = 1000;
  return {
    edgesCreated: tracker.edgesCreated,
    remainingQuota: rateLimitPerHour - tracker.edgesCreated,
    resetTime: tracker.resetTime,
  };
}
