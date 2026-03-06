import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Ontology, Concept, Relationship } from '../models/ontology.schema';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { MappingResult } from '../mapping/generator';
import type { PredictedRelationship } from '../mapping/link-prediction';
import { parse, valid } from 'semver';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface EnrichmentResult {
  enrichedOntology: Ontology;
  newVersion: string;
  relationshipsAdded: number;
  conceptsAdded: number;
}

/**
 * Enriches ontology with discovered relationships and potentially new concepts
 * from datasource metadata and mappings.
 */
export async function enrichOntology(
  currentOntology: Ontology,
  currentVersion: string,
  mappings: MappingResult,
  metadata: DatasourceMetadata,
  predictedRelationships: PredictedRelationship[],
): Promise<EnrichmentResult> {
  const logger = await getLogger();

  logger.info('[OntologyEnricher] Starting ontology enrichment', {
    currentVersion,
    conceptsCount: currentOntology.ontology.concepts.length,
    predictedRelationshipsCount: predictedRelationships.length,
    tablesCount: metadata.tables.length,
  });

  const enrichedOntology: Ontology = {
    ontology: {
      concepts: JSON.parse(JSON.stringify(currentOntology.ontology.concepts)) as Concept[],
      inheritance: currentOntology.ontology.inheritance ? [...currentOntology.ontology.inheritance] : [],
    },
  };

  const conceptMap = new Map<string, Concept>();
  for (const concept of enrichedOntology.ontology.concepts) {
    conceptMap.set(concept.id, concept);
  }

  let relationshipsAdded = 0;
  let conceptsAdded = 0;

  // Add predicted relationships to existing concepts
  for (const predicted of predictedRelationships) {
    const sourceConcept = conceptMap.get(predicted.sourceConcept);
    const targetConcept = conceptMap.get(predicted.targetConcept);

    if (!sourceConcept || !targetConcept) {
      logger.debug('[OntologyEnricher] Skipping relationship - concept not found', {
        sourceConcept: predicted.sourceConcept,
        targetConcept: predicted.targetConcept,
      });
      continue;
    }

    // Check if relationship already exists
    const existingRel = sourceConcept.relationships?.find(
      (r) => r.target === predicted.targetConcept && r.type === predicted.relationshipType,
    );

    if (existingRel) {
      logger.debug('[OntologyEnricher] Relationship already exists', {
        sourceConcept: predicted.sourceConcept,
        targetConcept: predicted.targetConcept,
        type: predicted.relationshipType,
      });
      continue;
    }

    // Add new relationship
    const newRelationship: Relationship = {
      target: predicted.targetConcept,
      type: predicted.relationshipType,
      label: `${sourceConcept.label} → ${targetConcept.label}`,
      description: `Discovered relationship from ${predicted.sourceTable} to ${predicted.targetTable} (confidence: ${predicted.confidence.toFixed(2)})`,
    };

    if (!sourceConcept.relationships) {
      sourceConcept.relationships = [];
    }
    sourceConcept.relationships.push(newRelationship);
    relationshipsAdded++;

    logger.debug('[OntologyEnricher] Added relationship', {
      sourceConcept: predicted.sourceConcept,
      targetConcept: predicted.targetConcept,
      type: predicted.relationshipType,
      confidence: predicted.confidence,
    });
  }

  // Identify unmapped tables with high confidence potential (>0.8)
  const mappedTableKeys = new Set<string>();
  for (const mapping of mappings.table_mappings) {
    const tableKey = `${mapping.table_schema}.${mapping.table_name}`;
    mappedTableKeys.add(tableKey);
  }

  const unmappedTables = metadata.tables.filter(
    (table) => {
      const tableKey = `${table.schema}.${table.name}`;
      return !mappedTableKeys.has(tableKey);
    },
  );

  // For now, we don't auto-create new concepts from unmapped tables
  // This would require LLM analysis and is better done manually or via explicit tool
  // But we log them for visibility
  if (unmappedTables.length > 0) {
    logger.info('[OntologyEnricher] Unmapped tables found (not auto-creating concepts)', {
      unmappedCount: unmappedTables.length,
      tables: unmappedTables.map((t) => `${t.schema}.${t.name}`),
    });
  }

  // Calculate new version using semantic versioning
  const newVersion = calculateNextVersion(currentVersion, relationshipsAdded, conceptsAdded);
  
  if (newVersion === '1.0.1' && currentVersion !== '1.0.0') {
    logger.warn('[OntologyEnricher] Could not parse version, defaulting to patch increment', {
      currentVersion,
    });
  }

  logger.info('[OntologyEnricher] Ontology enrichment complete', {
    currentVersion,
    newVersion,
    relationshipsAdded,
    conceptsAdded,
    totalConcepts: enrichedOntology.ontology.concepts.length,
    totalRelationships: enrichedOntology.ontology.concepts.reduce(
      (sum, c) => sum + (c.relationships?.length || 0),
      0,
    ),
  });

  return {
    enrichedOntology,
    newVersion,
    relationshipsAdded,
    conceptsAdded,
  };
}

/**
 * Calculate next semantic version based on changes.
 * - Patch increment (x.y.Z+1) for relationship additions only
 * - Minor increment (x.Y+1.0) for new concepts
 * - Major increment would require manual intervention
 */
function calculateNextVersion(
  currentVersion: string,
  relationshipsAdded: number,
  conceptsAdded: number,
): string {
  // Try to parse as semver
  const parsed = valid(currentVersion);
  if (parsed) {
    const parts = parse(parsed);
    if (parts) {
      if (conceptsAdded > 0) {
        // Minor version bump for new concepts
        return `${parts.major}.${parts.minor + 1}.0`;
      } else if (relationshipsAdded > 0) {
        // Patch version bump for new relationships
        return `${parts.major}.${parts.minor}.${parts.patch + 1}`;
      }
      // No changes, return current version
      return currentVersion;
    }
  }

  // Fallback: if not valid semver, try to parse manually
  const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (match) {
    const major = parseInt(match[1]!, 10);
    const minor = parseInt(match[2]!, 10);
    const patch = parseInt(match[3]!, 10);

    if (conceptsAdded > 0) {
      return `${major}.${minor + 1}.0`;
    } else if (relationshipsAdded > 0) {
      return `${major}.${minor}.${patch + 1}`;
    }
    return currentVersion;
  }

  // If we can't parse, default to incrementing patch
  // Note: logger not available in sync function, so we'll log at call site if needed
  return '1.0.1';
}
