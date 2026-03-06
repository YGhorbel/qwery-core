import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Ontology, Concept } from '../models/ontology.schema';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { LanguageModel } from 'ai';
import { detectSchemaChanges, analyzeChangeImpact } from './change-detector';
import { getVersionManager } from './version-manager';
import { buildOntologyFromDatasource } from './builder';
import { discoverRelationships } from '../graph/relationship-discovery';
import type { MappingResult } from '../mapping/generator';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface OntologyDelta {
  newConcepts: Concept[];
  updatedConcepts: Concept[];
  deprecatedConcepts: string[];
  newRelationships: number;
  version: string;
}

export interface EvolutionResult {
  newOntology: Ontology;
  delta: OntologyDelta;
  previousVersion: string;
  newVersion: string;
}

/**
 * Continuous ontology evolution: monitors datasource changes and triggers updates.
 */
export class ContinuousEvolution {
  private schemaSnapshots = new Map<string, DatasourceMetadata>(); // datasourceId -> last snapshot

  /**
   * Evolve ontology based on datasource changes.
   */
  async evolveOntology(
    datasourceId: string,
    currentMetadata: DatasourceMetadata,
    existingOntology: Ontology | null,
    existingVersion: string,
    mappings: MappingResult,
    languageModel: LanguageModel,
  ): Promise<EvolutionResult | null> {
    const logger = await getLogger();

    const previousMetadata = this.schemaSnapshots.get(datasourceId) || null;

    // Detect changes
    const diff = await detectSchemaChanges(previousMetadata, currentMetadata);

    if (diff.changes.length === 0) {
      logger.debug('[ContinuousEvolution] No schema changes detected', {
        datasourceId,
      });
      return null;
    }

    logger.info('[ContinuousEvolution] Schema changes detected', {
      datasourceId,
      changesCount: diff.changes.length,
      addedTables: diff.addedTables.length,
      removedTables: diff.removedTables.length,
      modifiedTables: diff.modifiedTables.length,
    });

    // Build table to concept mapping
    const tableToConceptMap = new Map<string, string>();
    if (existingOntology) {
      for (const concept of existingOntology.ontology.concepts) {
        // Find table mapping from mappings
        const mapping = mappings.table_mappings.find((m) => m.concept_id === concept.id);
        if (mapping) {
          const tableKey = `${mapping.table_schema}.${mapping.table_name}`;
          tableToConceptMap.set(tableKey, concept.id);
        }
      }
    }

    // Analyze impact
    const impact = analyzeChangeImpact(diff, tableToConceptMap);

    logger.info('[ContinuousEvolution] Change impact analysis', {
      datasourceId,
      affectedConcepts: impact.affectedConcepts.size,
      newConceptsNeeded: impact.newConceptsNeeded,
      deprecatedConcepts: impact.deprecatedConcepts.size,
    });

    // Build incremental ontology
    const delta = await this.buildIncrementalOntology(
      existingOntology,
      previousMetadata,
      currentMetadata,
      diff,
      languageModel,
    );

    // Calculate new version
    const versionManager = getVersionManager();
    const newVersion = versionManager.calculateNextVersion(existingVersion, {
      conceptsAdded: delta.newConcepts.length,
      conceptsRemoved: delta.deprecatedConcepts.length,
      relationshipsAdded: delta.newRelationships,
    });

    // Merge delta into existing ontology
    const newOntology = this.mergeOntologyDelta(existingOntology, delta);

    // Discover new relationships
    const discoveredRelationships = await discoverRelationships(
      currentMetadata,
      newOntology,
      mappings.table_mappings,
      {
        confidenceThreshold: 0.6,
        enableValueAnalysis: false, // Can be enabled later
        enableSemanticAnalysis: true,
      },
    );

    // Add discovered relationships
    for (const rel of discoveredRelationships) {
      const sourceConcept = newOntology.ontology.concepts.find((c) => c.id === rel.sourceConcept);
      if (sourceConcept && !sourceConcept.relationships?.some((r) => r.target === rel.targetConcept)) {
        if (!sourceConcept.relationships) {
          sourceConcept.relationships = [];
        }
        sourceConcept.relationships.push({
          target: rel.targetConcept,
          type: rel.relationshipType,
          label: `${sourceConcept.label} → ${rel.targetConcept}`,
          description: `Discovered relationship (confidence: ${rel.confidence.toFixed(2)})`,
        });
        delta.newRelationships++;
      }
    }

    // Update snapshot
    this.schemaSnapshots.set(datasourceId, currentMetadata);

    // Record version
    await versionManager.recordVersion(datasourceId, newVersion, newOntology, {
      conceptsAdded: delta.newConcepts.length,
      conceptsRemoved: delta.deprecatedConcepts.length,
      relationshipsAdded: delta.newRelationships,
    });

    logger.info('[ContinuousEvolution] Ontology evolution complete', {
      datasourceId,
      previousVersion: existingVersion,
      newVersion,
      conceptsAdded: delta.newConcepts.length,
      conceptsRemoved: delta.deprecatedConcepts.length,
      relationshipsAdded: delta.newRelationships,
    });

    return {
      newOntology,
      delta,
      previousVersion: existingVersion,
      newVersion,
    };
  }

  /**
   * Build incremental ontology delta from schema changes.
   */
  private async buildIncrementalOntology(
    existingOntology: Ontology | null,
    previousMetadata: DatasourceMetadata | null,
    currentMetadata: DatasourceMetadata,
    diff: Awaited<ReturnType<typeof detectSchemaChanges>>,
    languageModel: LanguageModel,
  ): Promise<OntologyDelta> {
    const logger = await getLogger();

    const newConcepts: Concept[] = [];
    const updatedConcepts: Concept[] = [];
    const deprecatedConcepts: string[] = [];

    // Build concepts for new tables
    if (diff.addedTables.length > 0) {
      const newTablesMetadata: DatasourceMetadata = {
        tables: diff.addedTables,
        columns: currentMetadata.columns.filter((c) =>
          diff.addedTables.some((t) => t.schema === c.schema && t.name === c.table),
        ),
      };

      const newOntology = await buildOntologyFromDatasource(newTablesMetadata, {
        useLLM: true,
        languageModel,
      });

      newConcepts.push(...newOntology.ontology.concepts);
    }

    // Update concepts for modified tables
    if (diff.modifiedTables.length > 0 && existingOntology) {
      for (const modified of diff.modifiedTables) {
        // Find existing concept
        const tableKey = `${modified.table.schema}.${modified.table.name}`;
        // This would need table-to-concept mapping, simplified for now
        logger.debug('[ContinuousEvolution] Table modified, concept update needed', {
          table: tableKey,
          addedColumns: modified.addedColumns.length,
          removedColumns: modified.removedColumns.length,
          modifiedColumns: modified.modifiedColumns.length,
        });
        // TODO: Implement concept update logic
      }
    }

    // Mark concepts as deprecated for removed tables
    if (diff.removedTables.length > 0 && existingOntology) {
      for (const removed of diff.removedTables) {
        const tableKey = `${removed.schema}.${removed.name}`;
        // Find concept and mark as deprecated
        // For now, we'll add to deprecated list
        logger.debug('[ContinuousEvolution] Table removed, concept should be deprecated', {
          table: tableKey,
        });
        // TODO: Implement concept deprecation
      }
    }

    return {
      newConcepts,
      updatedConcepts,
      deprecatedConcepts,
      newRelationships: 0, // Will be calculated after relationship discovery
      version: '', // Will be set by caller
    };
  }

  /**
   * Merge ontology delta into existing ontology.
   */
  private mergeOntologyDelta(existingOntology: Ontology | null, delta: OntologyDelta): Ontology {
    if (!existingOntology) {
      return {
        ontology: {
          concepts: delta.newConcepts,
          inheritance: [],
        },
      };
    }

    const merged: Ontology = {
      ontology: {
        concepts: [...existingOntology.ontology.concepts],
        inheritance: [...(existingOntology.ontology.inheritance || [])],
      },
    };

    // Add new concepts
    for (const newConcept of delta.newConcepts) {
      if (!merged.ontology.concepts.some((c) => c.id === newConcept.id)) {
        merged.ontology.concepts.push(newConcept);
      }
    }

    // Update existing concepts
    for (const updatedConcept of delta.updatedConcepts) {
      const index = merged.ontology.concepts.findIndex((c) => c.id === updatedConcept.id);
      if (index >= 0) {
        merged.ontology.concepts[index] = updatedConcept;
      }
    }

    // Remove deprecated concepts (for now, we just log them)
    // In a full implementation, we might want to mark them as deprecated rather than remove
    for (const deprecatedId of delta.deprecatedConcepts) {
      const index = merged.ontology.concepts.findIndex((c) => c.id === deprecatedId);
      if (index >= 0) {
        // For now, we keep them but could add a deprecated flag
        // merged.ontology.concepts.splice(index, 1);
      }
    }

    return merged;
  }

  /**
   * Get schema snapshot for a datasource.
   */
  getSchemaSnapshot(datasourceId: string): DatasourceMetadata | null {
    return this.schemaSnapshots.get(datasourceId) || null;
  }

  /**
   * Set schema snapshot for a datasource.
   */
  setSchemaSnapshot(datasourceId: string, metadata: DatasourceMetadata): void {
    this.schemaSnapshots.set(datasourceId, metadata);
  }
}

let instance: ContinuousEvolution | null = null;

export function getContinuousEvolution(): ContinuousEvolution {
  if (!instance) {
    instance = new ContinuousEvolution();
  }
  return instance;
}
