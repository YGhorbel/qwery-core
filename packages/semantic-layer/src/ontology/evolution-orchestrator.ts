import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Ontology } from '../models/ontology.schema';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { LanguageModel } from 'ai';
import type { MappingResult } from '../mapping/generator';
import { getContinuousEvolution } from './continuous-evolution';
import { getVersionManager } from './version-manager';
import { getMinIOStore } from '../storage/minio-store';
import { getRedisIndex } from '../index/redis-index';
import { getNATSPublisher } from '../events/nats-publisher';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface EvolutionConfig {
  confidenceThreshold?: number;
  enableValueAnalysis?: boolean;
  enableSemanticAnalysis?: boolean;
  autoStore?: boolean;
  publishEvents?: boolean;
}

/**
 * Orchestrates continuous ontology evolution workflow.
 * 
 * Workflow:
 * 1. Monitor: Detect datasource changes
 * 2. Analyze: Compare current vs. previous state
 * 3. Discover: Run relationship discovery on changes
 * 4. Build: Generate incremental ontology delta
 * 5. Validate: Validate new ontology version
 * 6. Align: Run heterogeneous graph alignment (future)
 * 7. Store: Store new version to MinIO
 * 8. Index: Update Redis index
 * 9. Publish: Emit NATS events
 * 10. Reason: Update graph instructions (future)
 */
export class EvolutionOrchestrator {
  /**
   * Execute full evolution workflow for a datasource.
   */
  async evolve(
    datasourceId: string,
    currentMetadata: DatasourceMetadata,
    existingOntology: Ontology | null,
    existingVersion: string,
    mappings: MappingResult,
    languageModel: LanguageModel,
    config: EvolutionConfig = {},
  ): Promise<{
    newOntology: Ontology;
    newVersion: string;
    previousVersion: string;
    changes: {
      conceptsAdded: number;
      conceptsRemoved: number;
      relationshipsAdded: number;
    };
  } | null> {
    const logger = await getLogger();

    logger.info('[EvolutionOrchestrator] Starting evolution workflow', {
      datasourceId,
      existingVersion,
      hasExistingOntology: !!existingOntology,
    });

    // Step 1-4: Evolve ontology (monitor, analyze, discover, build)
    const evolution = getContinuousEvolution();
    const evolutionResult = await evolution.evolveOntology(
      datasourceId,
      currentMetadata,
      existingOntology,
      existingVersion,
      mappings,
      languageModel,
    );

    if (!evolutionResult) {
      logger.info('[EvolutionOrchestrator] No changes detected, skipping evolution', {
        datasourceId,
      });
      return null;
    }

    // Step 5: Validate (basic validation for now)
    const validationResult = this.validateOntology(evolutionResult.newOntology);
    if (!validationResult.valid) {
      logger.error('[EvolutionOrchestrator] Ontology validation failed', {
        datasourceId,
        errors: validationResult.errors,
      });
      throw new Error(`Ontology validation failed: ${validationResult.errors.join(', ')}`);
    }

    logger.info('[EvolutionOrchestrator] Ontology validated successfully', {
      datasourceId,
      conceptsCount: evolutionResult.newOntology.ontology.concepts.length,
    });

    // Step 6: Align (placeholder for future heterogeneous graph alignment)
    // TODO: Implement heterogeneous graph alignment

    // Step 7: Store to MinIO
    if (config.autoStore !== false) {
      await this.storeOntology(datasourceId, evolutionResult.newVersion, evolutionResult.newOntology);
    }

    // Step 8: Update Redis index
    await this.updateIndex(datasourceId, evolutionResult.newVersion, evolutionResult.newOntology);

    // Step 9: Publish NATS events
    if (config.publishEvents !== false) {
      await this.publishEvents(datasourceId, evolutionResult);
    }

    // Step 10: Update graph instructions (placeholder for future)
    // TODO: Update graph instructions

    logger.info('[EvolutionOrchestrator] Evolution workflow complete', {
      datasourceId,
      previousVersion: evolutionResult.previousVersion,
      newVersion: evolutionResult.newVersion,
      conceptsAdded: evolutionResult.delta.newConcepts.length,
      relationshipsAdded: evolutionResult.delta.newRelationships,
    });

    return {
      newOntology: evolutionResult.newOntology,
      newVersion: evolutionResult.newVersion,
      previousVersion: evolutionResult.previousVersion,
      changes: {
        conceptsAdded: evolutionResult.delta.newConcepts.length,
        conceptsRemoved: evolutionResult.delta.deprecatedConcepts.length,
        relationshipsAdded: evolutionResult.delta.newRelationships,
      },
    };
  }

  /**
   * Validate ontology structure and consistency.
   */
  private validateOntology(ontology: Ontology): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check concepts exist
    if (ontology.ontology.concepts.length === 0) {
      errors.push('Ontology must have at least one concept');
    }

    // Check concept IDs are unique
    const conceptIds = new Set<string>();
    for (const concept of ontology.ontology.concepts) {
      if (conceptIds.has(concept.id)) {
        errors.push(`Duplicate concept ID: ${concept.id}`);
      }
      conceptIds.add(concept.id);
    }

    // Check relationships reference valid concepts
    for (const concept of ontology.ontology.concepts) {
      for (const rel of concept.relationships || []) {
        if (!conceptIds.has(rel.target)) {
          errors.push(`Relationship from ${concept.id} to ${rel.target} references non-existent concept`);
        }
      }
    }

    // Check property IDs are unique within concept
    for (const concept of ontology.ontology.concepts) {
      const propertyIds = new Set<string>();
      for (const prop of concept.properties || []) {
        if (propertyIds.has(prop.id)) {
          errors.push(`Duplicate property ID ${prop.id} in concept ${concept.id}`);
        }
        propertyIds.add(prop.id);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Store ontology to MinIO.
   */
  private async storeOntology(
    datasourceId: string,
    version: string,
    ontology: Ontology,
  ): Promise<void> {
    const logger = await getLogger();
    const minIOStore = getMinIOStore();

    if (!minIOStore) {
      logger.warn('[EvolutionOrchestrator] MinIO store not available, skipping storage');
      return;
    }

    try {
      const ontologyStore = minIOStore.createOntologyStore();
      const datasourceVersion = `datasource-${datasourceId}/${version}`;
      await ontologyStore.put(datasourceVersion, ontology);

      logger.info('[EvolutionOrchestrator] Ontology stored to MinIO', {
        datasourceId,
        version: datasourceVersion,
      });
    } catch (error) {
      logger.error('[EvolutionOrchestrator] Failed to store ontology', {
        datasourceId,
        version,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Update Redis index.
   */
  private async updateIndex(
    datasourceId: string,
    version: string,
    ontology: Ontology,
  ): Promise<void> {
    const logger = await getLogger();
    const redisIndex = getRedisIndex();

    if (!redisIndex) {
      logger.warn('[EvolutionOrchestrator] Redis index not available, skipping index update');
      return;
    }

    try {
      const datasourceVersion = `datasource-${datasourceId}/${version}`;
      const s3Path = `ontology/${datasourceVersion}/base.yaml`;
      await redisIndex.setOntologyIndex(datasourceVersion, {
        s3Path,
        version: datasourceVersion,
      });

      logger.info('[EvolutionOrchestrator] Redis index updated', {
        datasourceId,
        version: datasourceVersion,
      });
    } catch (error) {
      logger.warn('[EvolutionOrchestrator] Failed to update Redis index', {
        datasourceId,
        version,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - index update failure shouldn't block evolution
    }
  }

  /**
   * Publish NATS events for ontology evolution.
   */
  private async publishEvents(
    datasourceId: string,
    result: {
      newVersion: string;
      previousVersion: string;
      delta: {
        newConcepts: unknown[];
        deprecatedConcepts: string[];
        newRelationships: number;
      };
    },
  ): Promise<void> {
    const logger = await getLogger();
    const natsPublisher = getNATSPublisher();

    if (!natsPublisher) {
      logger.debug('[EvolutionOrchestrator] NATS publisher not available, skipping event publishing');
      return;
    }

    try {
      await natsPublisher.publishSemanticUpdate(
        datasourceId,
        result.newVersion,
        {
          conceptsAdded: result.delta.newConcepts.length,
          conceptsRemoved: result.delta.deprecatedConcepts.length,
          relationshipsAdded: result.delta.newRelationships,
          previousVersion: result.previousVersion,
        },
        {
          ontology: `ontology/datasource-${datasourceId}/${result.newVersion}/base.yaml`,
        },
      );

      logger.info('[EvolutionOrchestrator] Evolution event published', {
        datasourceId,
        newVersion: result.newVersion,
      });
    } catch (error) {
      logger.warn('[EvolutionOrchestrator] Failed to publish evolution event', {
        datasourceId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - event publishing failure shouldn't block evolution
    }
  }
}

let instance: EvolutionOrchestrator | null = null;

export function getEvolutionOrchestrator(): EvolutionOrchestrator {
  if (!instance) {
    instance = new EvolutionOrchestrator();
  }
  return instance;
}
