import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Datasource } from '@qwery/domain/entities';
import type { Repositories } from '@qwery/domain/repositories';
import {
  ExtensionsRegistry,
  type DatasourceExtension,
} from '@qwery/extensions-sdk';
import { getDriverInstance } from '@qwery/extensions-loader';
import { loadOntology } from '../ontology/loader';
import { loadMappings } from '../mapping/store';
import { generateMappings } from '../mapping/generator';
import { storeMappings } from '../mapping/store';
import { predictRelationships } from '../mapping/link-prediction';
import { enrichOntology } from '../ontology/enricher';
import { buildOntologyFromDatasource } from '../ontology/builder';
import { createMinIOClientFromEnv, setMinIOClient } from '../storage/minio-client';
import type { Ontology } from '../models/ontology.schema';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import { getEvolutionOrchestrator } from '../ontology/evolution-orchestrator';
import { getContinuousEvolution } from '../ontology/continuous-evolution';
import type { LanguageModel } from 'ai';
import type { MappingResult } from '../mapping/generator';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface AutoInitializeResult {
  initialized: string[];
  skipped: string[];
  errors: Array<{ datasourceId: string; error: string }>;
}

async function buildAndStoreOntology(
  datasourceId: string,
  metadata: DatasourceMetadata,
  languageModel: LanguageModel,
  version: string = '1.0.0',
): Promise<Ontology> {
  const logger = await getLogger();

  logger.info('[SemanticLayerInit] Building ontology from datasource', {
    datasourceId,
    tablesCount: metadata.tables.length,
    version,
  });

  // Build ontology from datasource metadata
  const ontology = await buildOntologyFromDatasource(metadata, {
    useLLM: true,
    languageModel,
  });

  // Store ontology to MinIO with datasource-specific path
  const { getMinIOStore } = await import('../storage/minio-store');
  const { getRedisIndex } = await import('../index/redis-index');
  const minIOStore = getMinIOStore();
  const redisIndex = getRedisIndex();

  if (!minIOStore || !redisIndex) {
    throw new Error('MinIO store or Redis index not available');
  }

  try {
    const ontologyStore = minIOStore.createOntologyStore();
    // Use datasource-specific version: datasource-{id}/1.0.0
    const datasourceVersion = `datasource-${datasourceId}/${version}`;
    await ontologyStore.put(datasourceVersion, ontology);

    const s3Path = `ontology/${datasourceVersion}/base.yaml`;
    await redisIndex.setOntologyIndex(datasourceVersion, {
      s3Path,
      version: datasourceVersion,
    });

    logger.info('[SemanticLayerInit] Ontology built and stored successfully', {
      datasourceId,
      version: datasourceVersion,
      conceptsCount: ontology.ontology.concepts.length,
    });

    return ontology;
  } catch (error) {
    logger.error('[SemanticLayerInit] Failed to store ontology', {
      datasourceId,
      version,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Automatically initialize semantic layer for PostgreSQL datasources.
 * Checks for ontology and mappings, generates mappings if missing.
 */
export interface AutoInitializeOptions {
  datasources: Datasource[];
  repositories: Repositories;
  ontologyVersion?: string;
  getLanguageModel?: (provider: string, model: string) => Promise<LanguageModel | null>;
}

export async function autoInitializeSemanticLayer(
  params: AutoInitializeOptions,
): Promise<AutoInitializeResult> {
  const logger = await getLogger();
  const { datasources, repositories, ontologyVersion = '1.0.0' } = params;

  const minIOClient = createMinIOClientFromEnv();
  if (minIOClient) {
    setMinIOClient(minIOClient);
    const { createMinIOStoreFromClient, setMinIOStore } = await import('../storage/minio-store');
    const minIOStore = createMinIOStoreFromClient(minIOClient);
    setMinIOStore(minIOStore);
    logger.info('[SemanticLayerInit] MinIO client and store initialized from environment');
  } else {
    throw new Error('MinIO is required for semantic layer. Set MINIO_ENDPOINT, MINIO_ACCESS_KEY_ID, and MINIO_SECRET_ACCESS_KEY environment variables.');
  }

  const { createRedisIndexFromEnv, setRedisIndex } = await import('../index/redis-index');
  const redisIndex = createRedisIndexFromEnv();
  try {
    await redisIndex.connect();
    setRedisIndex(redisIndex);
    logger.info('[SemanticLayerInit] Redis index initialized');
  } catch (error) {
    logger.warn('[SemanticLayerInit] Redis not available, some features may be limited', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const { createNATSPublisherFromEnv, setNATSPublisher } = await import('../events/nats-publisher');
  const natsPublisher = createNATSPublisherFromEnv();
  try {
    await natsPublisher.connect();
    setNATSPublisher(natsPublisher);
    logger.info('[SemanticLayerInit] NATS publisher initialized');
  } catch (error) {
    logger.warn('[SemanticLayerInit] NATS not available, event publishing disabled', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const result: AutoInitializeResult = {
    initialized: [],
    skipped: [],
    errors: [],
  };

  const postgresDatasources = datasources.filter(
    (ds) => ds.datasource_provider === 'postgresql',
  );

  if (postgresDatasources.length === 0) {
    logger.info('[SemanticLayerInit] No PostgreSQL datasources to initialize');
    return result;
  }

  logger.info('[SemanticLayerInit] Starting auto-initialization', {
    totalDatasources: datasources.length,
    postgresDatasources: postgresDatasources.length,
    ontologyVersion,
  });

  for (const datasource of postgresDatasources) {
    let driverInstance: Awaited<ReturnType<typeof getDriverInstance>> | undefined;

    try {
      logger.info('[SemanticLayerInit] Processing datasource', {
        datasourceId: datasource.id,
        datasourceName: datasource.name,
        provider: datasource.datasource_provider,
      });

      const extension = ExtensionsRegistry.get(
        datasource.datasource_provider,
      ) as DatasourceExtension | undefined;

      if (!extension?.drivers?.length) {
        result.skipped.push(datasource.id);
        logger.warn('[SemanticLayerInit] No driver found for datasource', {
          datasourceId: datasource.id,
          provider: datasource.datasource_provider,
        });
        continue;
      }

      const nodeDriver =
        extension.drivers.find((d) => d.runtime === 'node') ??
        extension.drivers[0];

      if (!nodeDriver) {
        result.skipped.push(datasource.id);
        logger.warn('[SemanticLayerInit] No node driver for datasource', {
          datasourceId: datasource.id,
        });
        continue;
      }

      driverInstance = await getDriverInstance(nodeDriver, {
        config: datasource.config,
      });

      // Get datasource metadata first (needed for ontology building)
      const metadata = await driverInstance.metadata();

      // Check if ontology already exists for this datasource
      const datasourceVersion = `datasource-${datasource.id}/${ontologyVersion}`;
      logger.info('[SemanticLayerInit] Checking ontology', {
        datasourceId: datasource.id,
        datasourceVersion,
      });

      let ontology = await loadOntology(datasourceVersion);
      
      if (!ontology) {
        // Build ontology from datasource metadata
        logger.info('[SemanticLayerInit] Building ontology from datasource', {
          datasourceId: datasource.id,
          tablesCount: metadata.tables.length,
        });

        // Check for available API keys (use Azure/GPT only)
        const azureApiKey =
          typeof process !== 'undefined' ? process.env.AZURE_API_KEY : undefined;
        const azureResourceName =
          typeof process !== 'undefined'
            ? process.env.AZURE_RESOURCE_NAME
            : undefined;

        let languageModel: LanguageModel | null = null;
        let providerName: string;

        if (azureApiKey && azureResourceName) {
          const modelName =
            typeof process !== 'undefined'
              ? process.env.AZURE_OPENAI_DEPLOYMENT ||
                process.env.VITE_AZURE_OPENAI_DEPLOYMENT ||
                'gpt-5.2-chat'
              : 'gpt-5.2-chat';
          
          // Try to get language model from provided function first (avoids circular dependency)
          if (params.getLanguageModel) {
            languageModel = await params.getLanguageModel('azure', modelName);
          }
          
          // Fallback to direct import if not provided
          if (!languageModel) {
            try {
              const providerModule = await import('@qwery/agent-factory-sdk/llm');
              const Provider = providerModule.Provider;
              const model = Provider.getModel('azure', modelName);
              languageModel = await Provider.getLanguage(model);
              providerName = 'Azure';
            } catch (importError) {
              logger.error('[SemanticLayerInit] Failed to import Provider', {
                error: importError instanceof Error ? importError.message : String(importError),
                datasourceId: datasource.id,
              });
              throw new Error(
                `Failed to import LLM Provider: ${importError instanceof Error ? importError.message : String(importError)}. Make sure @qwery/agent-factory-sdk is installed or provide getLanguageModel function.`,
              );
            }
          } else {
            providerName = 'Azure';
          }
          
          if (!languageModel) {
            throw new Error('Failed to get language model for ontology building');
          }
          
          try {
            ontology = await buildAndStoreOntology(
              datasource.id,
              metadata,
              languageModel,
              ontologyVersion,
            );
            logger.info('[SemanticLayerInit] Ontology built successfully', {
              datasourceId: datasource.id,
              conceptsCount: ontology.ontology.concepts.length,
            });

            // Publish NATS event for ontology creation
            const { getNATSPublisher } = await import('../events/nats-publisher');
            const natsPublisher = getNATSPublisher();
            if (natsPublisher) {
              try {
                await natsPublisher.publishSemanticUpdate(
                  datasource.id,
                  datasourceVersion,
                  {
                    conceptsAdded: ontology.ontology.concepts.length,
                  },
                  {
                    ontology: `ontology/${datasourceVersion}/base.yaml`,
                  },
                );
                logger.info('[SemanticLayerInit] Ontology creation event published', {
                  datasourceId: datasource.id,
                  version: datasourceVersion,
                });
              } catch (natsError) {
                logger.warn('[SemanticLayerInit] Failed to publish ontology creation event', {
                  datasourceId: datasource.id,
                  error: natsError instanceof Error ? natsError.message : String(natsError),
                });
              }
            }
          } catch (buildError) {
            result.errors.push({
              datasourceId: datasource.id,
              error: `Failed to build ontology: ${
                buildError instanceof Error
                  ? buildError.message
                  : String(buildError)
              }`,
            });
            logger.error('[SemanticLayerInit] Failed to build ontology', {
              datasourceId: datasource.id,
              error: buildError,
            });
            continue;
          }
        } else {
          result.errors.push({
            datasourceId: datasource.id,
            error: 'No LLM API key available for ontology generation. Set AZURE_API_KEY and AZURE_RESOURCE_NAME',
          });
          logger.error('[SemanticLayerInit] No LLM API key available', {
            datasourceId: datasource.id,
          });
          continue;
        }
      } else {
        logger.info('[SemanticLayerInit] Ontology already exists, checking for evolution', {
          datasourceId: datasource.id,
          datasourceVersion,
          conceptsCount: ontology.ontology.concepts.length,
        });

        // Check if ontology needs evolution (schema changes)
        const evolution = getContinuousEvolution();
        const previousSnapshot = evolution.getSchemaSnapshot(datasource.id);
        
        if (previousSnapshot) {
          // Try to evolve ontology based on schema changes
          try {
            const existingMappings = await loadMappings(datasource.id, datasourceVersion);
            if (existingMappings.length > 0) {
              const mappingResult: MappingResult = {
                table_mappings: existingMappings.map((m) => ({
                  table_schema: m.table_schema,
                  table_name: m.table_name,
                  concept_id: m.concept_id,
                  confidence: m.confidence,
                  synonyms: m.synonyms,
                  column_mappings: m.column_mappings,
                })),
              };

              let languageModel: LanguageModel | null = null;
              
              // Try to get language model from provided function first
              if (params.getLanguageModel) {
                languageModel = await params.getLanguageModel('azure', process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.2-chat');
              }
              
              // Fallback to direct import if not provided
              if (!languageModel) {
                try {
                  const providerModule = await import('@qwery/agent-factory-sdk/llm');
                  const Provider = providerModule.Provider;
                  const model = Provider.getModel('azure', process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.2-chat');
                  languageModel = await Provider.getLanguage(model);
                } catch (importError) {
                  logger.error('[SemanticLayerInit] Failed to import Provider for evolution', {
                    error: importError instanceof Error ? importError.message : String(importError),
                    datasourceId: datasource.id,
                  });
                  throw new Error(
                    `Failed to import LLM Provider: ${importError instanceof Error ? importError.message : String(importError)}`,
                  );
                }
              }
              
              if (!languageModel) {
                logger.warn('[SemanticLayerInit] No language model available for evolution, skipping', {
                  datasourceId: datasource.id,
                });
                continue;
              }

              const orchestrator = getEvolutionOrchestrator();
              const evolutionResult = await orchestrator.evolve(
                datasource.id,
                metadata,
                ontology,
                datasourceVersion,
                mappingResult,
                languageModel,
                {
                  autoStore: true,
                  publishEvents: true,
                },
              );

              if (evolutionResult) {
                logger.info('[SemanticLayerInit] Ontology evolved', {
                  datasourceId: datasource.id,
                  previousVersion: evolutionResult.previousVersion,
                  newVersion: evolutionResult.newVersion,
                  conceptsAdded: evolutionResult.changes.conceptsAdded,
                  relationshipsAdded: evolutionResult.changes.relationshipsAdded,
                });
                ontology = evolutionResult.newOntology;
              }
            }
          } catch (evolutionError) {
            logger.warn('[SemanticLayerInit] Ontology evolution failed, continuing with existing', {
              datasourceId: datasource.id,
              error: evolutionError instanceof Error ? evolutionError.message : String(evolutionError),
            });
          }
        } else {
          // Store current snapshot for future evolution checks
          evolution.setSchemaSnapshot(datasource.id, metadata);
        }
      }

      const finalOntology = ontology;
      if (!finalOntology) {
        result.errors.push({
          datasourceId: datasource.id,
          error: `Failed to get ontology after initialization`,
        });
        logger.error('[SemanticLayerInit] Ontology not available', {
          datasourceId: datasource.id,
        });
        continue;
      }

      // Check if mappings already exist
      logger.debug('[SemanticLayerInit] Checking existing mappings', {
        datasourceId: datasource.id,
        datasourceVersion,
      });

      const existingMappings = await loadMappings(
        datasource.id,
        datasourceVersion,
      );

      if (existingMappings.length > 0) {
        result.skipped.push(datasource.id);
        logger.info('[SemanticLayerInit] Mappings already exist', {
          datasourceId: datasource.id,
          mappingsCount: existingMappings.length,
        });
        continue;
      }

      logger.info('[SemanticLayerInit] Mapping check: not found', {
        datasourceId: datasource.id,
      });

      // Generate mappings automatically
      logger.info('[SemanticLayerInit] Generating mappings automatically', {
        datasourceId: datasource.id,
      });

      // Check for available API keys (use Azure/GPT only)
      const azureApiKey =
        typeof process !== 'undefined' ? process.env.AZURE_API_KEY : undefined;
      const azureResourceName =
        typeof process !== 'undefined'
          ? process.env.AZURE_RESOURCE_NAME
          : undefined;

      let languageModel: LanguageModel | null = null;
      let providerName: string;

      if (azureApiKey && azureResourceName) {
        const modelName =
          typeof process !== 'undefined'
            ? process.env.AZURE_OPENAI_DEPLOYMENT ||
              process.env.VITE_AZURE_OPENAI_DEPLOYMENT ||
              'gpt-5.2-chat'
            : 'gpt-5.2-chat';
        
        // Try to get language model from provided function first
        if (params.getLanguageModel) {
          languageModel = await params.getLanguageModel('azure', modelName);
        }
        
        // Fallback to direct import if not provided
        if (!languageModel) {
          try {
            const providerModule = await import('@qwery/agent-factory-sdk/llm');
            const Provider = providerModule.Provider;
            const model = Provider.getModel('azure', modelName);
            languageModel = await Provider.getLanguage(model);
            providerName = 'Azure';
          } catch (importError) {
            logger.error('[SemanticLayerInit] Failed to import Provider for mapping generation', {
              error: importError instanceof Error ? importError.message : String(importError),
              datasourceId: datasource.id,
            });
            result.errors.push({
              datasourceId: datasource.id,
              error: `Failed to import LLM Provider: ${importError instanceof Error ? importError.message : String(importError)}. Make sure @qwery/agent-factory-sdk is installed or provide getLanguageModel function.`,
            });
            continue;
          }
        } else {
          providerName = 'Azure';
        }
        
        if (!languageModel) {
          logger.error('[SemanticLayerInit] No language model available for mapping generation', {
            datasourceId: datasource.id,
          });
          result.errors.push({
            datasourceId: datasource.id,
            error: 'No language model available for mapping generation',
          });
          continue;
        }
      } else {
        result.skipped.push(datasource.id);
        logger.warn(
          '[SemanticLayerInit] Skipping mapping generation - No API key available',
          {
            datasourceId: datasource.id,
            suggestion:
              'Set AZURE_API_KEY and AZURE_RESOURCE_NAME environment variables to enable automatic mapping generation',
          },
        );
        continue;
      }

      logger.info(`[SemanticLayerInit] Generating mappings with ${providerName}`, {
        datasourceId: datasource.id,
        tablesCount: metadata.tables.length,
      });

      const mappings = await generateMappings(metadata, finalOntology, languageModel);

      logger.info('[SemanticLayerInit] Storing mappings', {
        datasourceId: datasource.id,
        tableMappingsCount: mappings.table_mappings.length,
      });

      const storeResult = await storeMappings(
        datasource.id,
        datasourceVersion,
        mappings,
      );

      // Predict relationships using link prediction
      logger.info('[SemanticLayerInit] Predicting relationships', {
        datasourceId: datasource.id,
      });

      const predictedRelationships = await predictRelationships(
        metadata,
        mappings,
        finalOntology,
        datasource.id,
        {
          confidenceThreshold: 0.6,
          rateLimitPerHour: 1000,
        },
      );

      logger.info('[SemanticLayerInit] Relationships predicted', {
        datasourceId: datasource.id,
        predictedCount: predictedRelationships.length,
      });

      // Enrich ontology with discovered relationships
      let enrichedOntologyVersion = datasourceVersion;
      let enrichmentResult = null;

      if (predictedRelationships.length > 0) {
        logger.info('[SemanticLayerInit] Enriching ontology with relationships', {
          datasourceId: datasource.id,
          relationshipsCount: predictedRelationships.length,
        });

        enrichmentResult = await enrichOntology(
          finalOntology,
          datasourceVersion,
          mappings,
          metadata,
          predictedRelationships,
        );

        if (enrichmentResult.relationshipsAdded > 0 || enrichmentResult.conceptsAdded > 0) {
          // Parse version to increment properly
          const versionParts = datasourceVersion.split('/');
          const basePath = versionParts[0]!; // datasource-{id}
          const version = versionParts[1]!; // 1.0.0
          enrichedOntologyVersion = `${basePath}/${enrichmentResult.newVersion}`;

          // Store enriched ontology
          const { getMinIOStore } = await import('../storage/minio-store');
          const { getRedisIndex } = await import('../index/redis-index');
          const minIOStore = getMinIOStore();
          const redisIndex = getRedisIndex();

          if (minIOStore && redisIndex) {
            const ontologyStore = minIOStore.createOntologyStore();
            await ontologyStore.put(enrichedOntologyVersion, enrichmentResult.enrichedOntology);

            const s3Path = `ontology/${enrichedOntologyVersion}/base.yaml`;
            await redisIndex.setOntologyIndex(enrichedOntologyVersion, {
              s3Path,
              version: enrichedOntologyVersion,
            });

            logger.info('[SemanticLayerInit] Enriched ontology stored', {
              datasourceId: datasource.id,
              oldVersion: datasourceVersion,
              newVersion: enrichedOntologyVersion,
              relationshipsAdded: enrichmentResult.relationshipsAdded,
              conceptsAdded: enrichmentResult.conceptsAdded,
            });
          }
        }
      }

      // Publish NATS event for mapping generation
      const { getNATSPublisher } = await import('../events/nats-publisher');
      const natsPublisher = getNATSPublisher();

      if (natsPublisher) {
        try {
          await natsPublisher.publishSemanticUpdate(
            datasource.id,
            enrichedOntologyVersion,
            {
              mappingsAdded: storeResult.tableMappingsCreated,
              conceptsAdded: enrichmentResult?.conceptsAdded || 0,
            },
            {
              mappings: `mappings/${datasource.id}/${ontologyVersion}/mappings.json`,
            },
          );

          logger.info('[SemanticLayerInit] NATS event published', {
            datasourceId: datasource.id,
            version: enrichedOntologyVersion,
          });
        } catch (natsError) {
          logger.warn('[SemanticLayerInit] Failed to publish NATS event', {
            datasourceId: datasource.id,
            error: natsError instanceof Error ? natsError.message : String(natsError),
          });
        }
      }

      result.initialized.push(datasource.id);

      logger.info('[SemanticLayerInit] Initialization complete', {
        datasourceId: datasource.id,
        tableMappingsCreated: storeResult.tableMappingsCreated,
        columnMappingsCreated: storeResult.columnMappingsCreated,
        relationshipsPredicted: predictedRelationships.length,
        ontologyEnriched: enrichmentResult !== null,
        enrichedVersion: enrichedOntologyVersion,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      result.errors.push({
        datasourceId: datasource.id,
        error: errorMessage,
      });

      logger.error('[SemanticLayerInit] Initialization failed', {
        datasourceId: datasource.id,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      if (driverInstance && typeof driverInstance.close === 'function') {
        try {
          await driverInstance.close();
        } catch (closeError) {
          logger.warn('[SemanticLayerInit] Failed to close driver instance', {
            datasourceId: datasource.id,
            error: closeError,
          });
        }
      }
    }
  }

  logger.info('[SemanticLayerInit] Auto-initialization complete', {
    initialized: result.initialized.length,
    skipped: result.skipped.length,
    errors: result.errors.length,
  });

  return result;
}
