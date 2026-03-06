import { randomUUID } from 'node:crypto';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import { parse } from 'yaml';
import { validateOntology } from '../loader/yaml-loader';
import type { Ontology } from '../models/ontology.schema';
import type { MappingResult } from '../mapping/generator';
import { MinIOStore } from '../storage/minio-store';
import { RedisIndex } from '../index/redis-index';
import { NATSPublisher } from './nats-publisher';
import { predictRelationships } from '../mapping/link-prediction';
import { generateMappings } from '../mapping/generator';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { LanguageModel } from 'ai';
import { valid, inc, parse as parseVersion } from 'semver';
import { getMinIOClient } from '../storage/minio-client';
import { getEvolutionOrchestrator } from '../ontology/evolution-orchestrator';
import { getContinuousEvolution } from '../ontology/continuous-evolution';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface MinIOEvent {
  EventName: string;
  Key: string;
  Records?: Array<{
    eventName: string;
    s3: {
      object: {
        key: string;
      };
      bucket: {
        name: string;
      };
    };
  }>;
}

export interface MinIOListenerConfig {
  minIOStore: MinIOStore;
  redisIndex: RedisIndex;
  natsPublisher: NATSPublisher;
  confidenceThreshold?: number;
  rateLimitPerHour?: number;
  dryRun?: boolean;
  getDatasourceMetadata?: (datasourceId: string) => Promise<DatasourceMetadata | null>;
  getLanguageModel?: () => LanguageModel | null;
  triggerEvolution?: boolean; // Enable continuous evolution on changes
}

export class MinIOEventListener {
  private config: MinIOListenerConfig;

  constructor(config: MinIOListenerConfig) {
    this.config = config;
  }

  async handleEvent(event: MinIOEvent): Promise<void> {
    const logger = await getLogger();
    logger.info('[MinIOEventListener] Received event', {
      eventName: event.EventName,
      key: event.Key,
    });

    if (event.Records) {
      for (const record of event.Records) {
        await this.handleRecord(record);
      }
    } else if (event.Key) {
      await this.handleObjectCreated(event.Key, event.EventName);
    }
  }

  private async handleRecord(record: {
    eventName: string;
    s3: { object: { key: string }; bucket: { name: string } };
  }): Promise<void> {
    if (record.eventName.startsWith('s3:ObjectCreated')) {
      await this.handleObjectCreated(record.s3.object.key, record.eventName);
    } else if (record.eventName.startsWith('s3:ObjectRemoved')) {
      await this.handleObjectRemoved(record.s3.object.key);
    }
  }

  private async handleObjectCreated(key: string, eventName: string): Promise<void> {
    const logger = await getLogger();

    if (key.startsWith('incoming/')) {
      const match = key.match(/^incoming\/([^/]+)\/(ontology|mappings)\/(.+)$/);
      if (match && match[1] && match[2] && match[3]) {
        const datasourceId = match[1];
        const type = match[2];
        const filename = match[3];
        if (type === 'ontology' && filename.endsWith('.yaml')) {
          await this.handleOntologyUpload(datasourceId, key);
        } else if (type === 'mappings' && filename.endsWith('.json')) {
          await this.handleMappingUpload(datasourceId, key);
        }
      }
    }
  }

  private async handleObjectRemoved(key: string): Promise<void> {
    const logger = await getLogger();
    logger.debug('[MinIOEventListener] Object removed', { key });
  }

  private async handleOntologyUpload(datasourceId: string, objectKey: string): Promise<void> {
    const logger = await getLogger();
    const startTime = Date.now();

    logger.info('[MinIOEventListener] Processing ontology upload', {
      datasourceId,
      objectKey,
      dryRun: this.config.dryRun,
    });

    try {
      const minIOClient = this.config.minIOStore['client'];
      if (!minIOClient) {
        throw new Error('MinIO client not available');
      }

      const object = await minIOClient.getObject(objectKey);
      if (!object) {
        throw new Error(`Object not found: ${objectKey}`);
      }

      const parsed = parse(object.content);
      const ontology = validateOntology(parsed);

      const existingVersions = await this.config.minIOStore.createOntologyStore().listVersions();
      const latestVersion = existingVersions[0]?.version || '1.0.0';
      const newVersion = this.generateNextVersion(latestVersion);

      if (this.config.dryRun) {
        logger.info('[MinIOEventListener] Dry run - would create version', {
          datasourceId,
          newVersion,
        });
        return;
      }

      const ontologyStore = this.config.minIOStore.createOntologyStore();
      await ontologyStore.put(newVersion, ontology);

      const s3Path = `ontology/${newVersion}/base.yaml`;
      await this.config.redisIndex.setOntologyIndex(newVersion, {
        s3Path,
        version: newVersion,
      });

      const diffSummary = this.calculateOntologyDiff(existingVersions.length > 0 ? await ontologyStore.get(latestVersion) : null, ontology);

      await this.config.natsPublisher.publishSemanticUpdate(
        datasourceId,
        newVersion,
        diffSummary,
        {
          ontology: this.calculateChecksum(object.content),
        },
      );

      const duration = Date.now() - startTime;
      logger.info('[MinIOEventListener] Ontology processed successfully', {
        datasourceId,
        version: newVersion,
        durationMs: duration,
      });
    } catch (error) {
      await this.handleError(datasourceId, objectKey, error, 'ontology');
      throw error;
    }
  }

  private async handleMappingUpload(datasourceId: string, objectKey: string): Promise<void> {
    const logger = await getLogger();
    const startTime = Date.now();

    logger.info('[MinIOEventListener] Processing mapping upload', {
      datasourceId,
      objectKey,
      dryRun: this.config.dryRun,
    });

    try {
      const minIOClient = this.config.minIOStore['client'];
      if (!minIOClient) {
        throw new Error('MinIO client not available');
      }

      const object = await minIOClient.getObject(objectKey);
      if (!object) {
        throw new Error(`Object not found: ${objectKey}`);
      }

      const mappings = JSON.parse(object.content) as MappingResult;

      const ontologyStore = this.config.minIOStore.createOntologyStore();
      let ontology = await ontologyStore.get('latest');
      if (!ontology) {
        throw new Error('Ontology not found. Upload ontology first.');
      }

      const existingVersions = await this.config.minIOStore.createMappingStore().listVersions(datasourceId);
      const latestVersion = existingVersions[0]?.version || '1.0.0';
      const newVersion = this.generateNextVersion(latestVersion);

      let enrichedMappings = mappings;

      if (this.config.getDatasourceMetadata) {
        const metadata = await this.config.getDatasourceMetadata(datasourceId);
        if (metadata) {
          // Trigger continuous evolution if enabled
          if (this.config.triggerEvolution && this.config.getLanguageModel) {
            const languageModel = this.config.getLanguageModel();
            if (languageModel) {
              try {
                const orchestrator = getEvolutionOrchestrator();
                const existingMappings: MappingResult = mappings;
                const evolutionResult = await orchestrator.evolve(
                  datasourceId,
                  metadata,
                  ontology,
                  latestVersion,
                  existingMappings,
                  languageModel,
                  {
                    autoStore: true,
                    publishEvents: true,
                  },
                );

                if (evolutionResult) {
                  logger.info('[MinIOEventListener] Ontology evolved during mapping processing', {
                    datasourceId,
                    newVersion: evolutionResult.newVersion,
                    conceptsAdded: evolutionResult.changes.conceptsAdded,
                  });
                  ontology = evolutionResult.newOntology;
                }
              } catch (evolutionError) {
                logger.warn('[MinIOEventListener] Evolution failed during mapping processing', {
                  datasourceId,
                  error: evolutionError instanceof Error ? evolutionError.message : String(evolutionError),
                });
              }
            }
          }

          const predictedRelationships = await predictRelationships(
            metadata,
            mappings,
            ontology,
            datasourceId,
            {
              confidenceThreshold: this.config.confidenceThreshold ?? 0.6,
              rateLimitPerHour: this.config.rateLimitPerHour ?? 1000,
            },
          );

          if (predictedRelationships.length > 0) {
            for (const concept of ontology.ontology.concepts) {
              for (const predRel of predictedRelationships) {
                if (concept.id === predRel.sourceConcept) {
                  if (!concept.relationships) {
                    concept.relationships = [];
                  }
                  concept.relationships.push({
                    target: predRel.targetConcept,
                    type: predRel.relationshipType,
                    label: `${predRel.sourceConcept} → ${predRel.targetConcept}`,
                  });
                }
              }
            }
          }
        }
      }

      if (this.config.dryRun) {
        logger.info('[MinIOEventListener] Dry run - would create version', {
          datasourceId,
          newVersion,
        });
        return;
      }

      const mappingStore = this.config.minIOStore.createMappingStore();
      await mappingStore.put(datasourceId, newVersion, enrichedMappings);

      const s3Path = `mappings/${datasourceId}/${newVersion}/mappings.json`;
      for (const tableMapping of enrichedMappings.table_mappings) {
        await this.config.redisIndex.setMappingIndex(datasourceId, tableMapping.concept_id, {
          s3Path,
          version: newVersion,
        });
      }

      const diffSummary = this.calculateMappingDiff(
        existingVersions.length > 0 ? await mappingStore.get(datasourceId, latestVersion) : null,
        enrichedMappings,
      );

      await this.config.natsPublisher.publishSemanticUpdate(
        datasourceId,
        newVersion,
        diffSummary,
        {
          mappings: this.calculateChecksum(object.content),
        },
      );

      const duration = Date.now() - startTime;
      logger.info('[MinIOEventListener] Mapping processed successfully', {
        datasourceId,
        version: newVersion,
        durationMs: duration,
      });
    } catch (error) {
      await this.handleError(datasourceId, objectKey, error, 'mapping');
      throw error;
    }
  }

  private async handleError(
    datasourceId: string,
    objectKey: string,
    error: unknown,
    type: 'ontology' | 'mapping',
  ): Promise<void> {
    const logger = await getLogger();
    const errorId = randomUUID();
    const invalidPath = `incoming/${datasourceId}/invalid/${errorId}.json`;

    logger.error('[MinIOEventListener] Processing failed', {
      datasourceId,
      objectKey,
      type,
      errorId,
      error: error instanceof Error ? error.message : String(error),
    });

    try {
      const minIOClient = getMinIOClient();
      if (minIOClient) {
        const errorDetails = {
          errorId,
          datasourceId,
          originalPath: objectKey,
          type,
          timestamp: new Date().toISOString(),
          error: {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
        };
        await minIOClient.putObject(invalidPath, JSON.stringify(errorDetails, null, 2), 'application/json');
      }

      await this.config.natsPublisher.publishSemanticUpdateFailed(datasourceId, error instanceof Error ? error : new Error(String(error)), {
        objectKey,
        type,
        errorId,
      });
    } catch (publishError) {
      logger.error('[MinIOEventListener] Failed to publish error event', {
        error: publishError instanceof Error ? publishError.message : String(publishError),
      });
    }
  }

  private generateNextVersion(currentVersion: string): string {
    try {
      if (valid(currentVersion)) {
        return inc(currentVersion, 'patch') || '1.0.1';
      }
      const parsed = parseVersion(currentVersion);
      if (parsed) {
        return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
      }
    } catch {
    }
    return '1.0.1';
  }

  private calculateOntologyDiff(
    oldOntology: Ontology | null,
    newOntology: Ontology,
  ): { conceptsAdded?: number; conceptsRemoved?: number } {
    if (!oldOntology) {
      return {
        conceptsAdded: newOntology.ontology.concepts.length,
      };
    }

    const oldConceptIds = new Set(oldOntology.ontology.concepts.map((c) => c.id));
    const newConceptIds = new Set(newOntology.ontology.concepts.map((c) => c.id));

    const added = Array.from(newConceptIds).filter((id) => !oldConceptIds.has(id)).length;
    const removed = Array.from(oldConceptIds).filter((id) => !newConceptIds.has(id)).length;

    return {
      conceptsAdded: added > 0 ? added : undefined,
      conceptsRemoved: removed > 0 ? removed : undefined,
    };
  }

  private calculateMappingDiff(
    oldMappings: MappingResult | null,
    newMappings: MappingResult,
  ): { mappingsAdded?: number; mappingsRemoved?: number } {
    if (!oldMappings) {
      return {
        mappingsAdded: newMappings.table_mappings.length,
      };
    }

    const oldMappingKeys = new Set(
      oldMappings.table_mappings.map((m) => `${m.table_schema}.${m.table_name}`),
    );
    const newMappingKeys = new Set(
      newMappings.table_mappings.map((m) => `${m.table_schema}.${m.table_name}`),
    );

    const added = Array.from(newMappingKeys).filter((key) => !oldMappingKeys.has(key)).length;
    const removed = Array.from(oldMappingKeys).filter((key) => !newMappingKeys.has(key)).length;

    return {
      mappingsAdded: added > 0 ? added : undefined,
      mappingsRemoved: removed > 0 ? removed : undefined,
    };
  }

  private calculateChecksum(content: string): string {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    return Array.from(new Uint8Array(data))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
