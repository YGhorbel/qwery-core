import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { Ontology } from '../models/ontology.schema';
import type { LanguageModel } from 'ai';
import type { MappingResult } from '../mapping/generator';
import { getTrainingDataCollector, type TrainingExample } from './data-collector';
import { getOntologyTrainer } from './ontology-trainer';
import { loadOntology } from '../ontology/loader';
import { loadMappings } from '../mapping/store';
import { getMinIOStore } from '../storage/minio-store';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface LearningLoopConfig {
  enabled?: boolean;
  minExamplesForTraining?: number;
  trainingIntervalHours?: number;
  autoTrainOnSuccess?: boolean;
}

/**
 * Continuous learning from query executions.
 * 
 * Workflow:
 * 1. Execute query → Collect result
 * 2. If successful → Add to training data
 * 3. Periodically → Train ontology with collected data
 * 4. Update mappings → Improve future queries
 */
export class LearningLoop {
  private config: LearningLoopConfig;
  private lastTrainingTime = new Map<string, Date>();

  constructor(config: LearningLoopConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      minExamplesForTraining: config.minExamplesForTraining ?? 10,
      trainingIntervalHours: config.trainingIntervalHours ?? 24,
      autoTrainOnSuccess: config.autoTrainOnSuccess ?? false,
    };
  }

  /**
   * Collect a successful query execution for training.
   */
  async collectSuccessfulQuery(
    datasourceId: string,
    ontologyVersion: string,
    example: Omit<TrainingExample, 'datasourceId' | 'ontologyVersion' | 'timestamp'>,
  ): Promise<void> {
    const logger = await getLogger();

    if (!this.config.enabled) {
      return;
    }

    try {
      const collector = getTrainingDataCollector();
      await collector.collectExample({
        ...example,
        datasourceId,
        ontologyVersion,
        timestamp: new Date(),
      });

      logger.debug('[LearningLoop] Collected successful query', {
        datasourceId,
        queryLength: example.naturalLanguageQuery.length,
      });

      // Auto-train if enabled and enough examples
      if (this.config.autoTrainOnSuccess) {
        await this.checkAndTrain(datasourceId, ontologyVersion);
      }
    } catch (error) {
      logger.warn('[LearningLoop] Failed to collect query', {
        error: error instanceof Error ? error.message : String(error),
        datasourceId,
      });
    }
  }

  /**
   * Check if training is needed and run it.
   */
  async checkAndTrain(
    datasourceId: string,
    ontologyVersion: string,
    metadata?: DatasourceMetadata,
    languageModel?: LanguageModel,
  ): Promise<boolean> {
    const logger = await getLogger();

    if (!this.config.enabled) {
      return false;
    }

    // Check if enough time has passed since last training
    const lastTraining = this.lastTrainingTime.get(datasourceId);
    if (lastTraining) {
      const hoursSinceLastTraining =
        (Date.now() - lastTraining.getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastTraining < (this.config.trainingIntervalHours || 24)) {
        logger.debug('[LearningLoop] Training skipped, too soon since last training', {
          datasourceId,
          hoursSinceLastTraining: hoursSinceLastTraining.toFixed(2),
        });
        return false;
      }
    }

    try {
      const collector = getTrainingDataCollector();
      const examples = await collector.getTrainingDataset(
        datasourceId,
        ontologyVersion,
        this.config.minExamplesForTraining || 10,
      );

      if (examples.length < (this.config.minExamplesForTraining || 10)) {
        logger.debug('[LearningLoop] Insufficient examples for training', {
          datasourceId,
          examplesCount: examples.length,
          minRequired: this.config.minExamplesForTraining || 10,
        });
        return false;
      }

      // Load current ontology and mappings
      const currentOntology = await loadOntology(ontologyVersion);
      if (!currentOntology) {
        logger.warn('[LearningLoop] Cannot train, ontology not found', {
          datasourceId,
          ontologyVersion,
        });
        return false;
      }

      const currentMappings = await loadMappings(datasourceId, ontologyVersion);

      if (!metadata || !languageModel) {
        logger.warn('[LearningLoop] Cannot train, metadata or language model not provided', {
          datasourceId,
        });
        return false;
      }

      // Run training
      const trainer = getOntologyTrainer();
      const result = await trainer.trainFromStructuredData(
        datasourceId,
        metadata,
        examples,
        currentOntology,
        currentMappings,
        languageModel,
        {
          useQueryHistory: true,
          useSchemaAnalysis: true,
          useStatisticalPatterns: true,
        },
      );

      // Store improved ontology and mappings
      if (result.trainingMetrics.mappingsImproved > 0 || result.trainingMetrics.conceptsRefined > 0) {
        const minIOStore = getMinIOStore();
        if (minIOStore) {
          const ontologyStore = minIOStore.createOntologyStore();
          await ontologyStore.put(ontologyVersion, result.improvedOntology);

          const mappingStore = minIOStore.createMappingStore();
          await mappingStore.put(datasourceId, ontologyVersion, result.improvedMappings);

          logger.info('[LearningLoop] Training complete, ontology and mappings updated', {
            datasourceId,
            mappingsImproved: result.trainingMetrics.mappingsImproved,
            conceptsRefined: result.trainingMetrics.conceptsRefined,
          });

          this.lastTrainingTime.set(datasourceId, new Date());
          return true;
        }
      }

      logger.info('[LearningLoop] Training complete, no improvements', {
        datasourceId,
        metrics: result.trainingMetrics,
      });

      this.lastTrainingTime.set(datasourceId, new Date());
      return false;
    } catch (error) {
      logger.error('[LearningLoop] Training failed', {
        error: error instanceof Error ? error.message : String(error),
        datasourceId,
      });
      return false;
    }
  }

  /**
   * Schedule periodic training for a datasource.
   */
  scheduleTraining(
    datasourceId: string,
    ontologyVersion: string,
    metadata: DatasourceMetadata,
    languageModel: LanguageModel,
  ): void {
    const logger = await getLogger();

    if (!this.config.enabled) {
      return;
    }

    const intervalMs = (this.config.trainingIntervalHours || 24) * 60 * 60 * 1000;

    setInterval(async () => {
      await this.checkAndTrain(datasourceId, ontologyVersion, metadata, languageModel);
    }, intervalMs);

    logger.info('[LearningLoop] Scheduled periodic training', {
      datasourceId,
      intervalHours: this.config.trainingIntervalHours || 24,
    });
  }
}

// Singleton instance
let learningLoopInstance: LearningLoop | null = null;

export function getLearningLoop(config?: LearningLoopConfig): LearningLoop {
  if (!learningLoopInstance) {
    learningLoopInstance = new LearningLoop(config);
  }
  return learningLoopInstance;
}
