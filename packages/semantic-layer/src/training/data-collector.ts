import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { SemanticPlan } from '../compiler/types';
import { getMinIOStore } from '../storage/minio-store';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface TrainingExample {
  naturalLanguageQuery: string;
  semanticPlan: SemanticPlan;
  generatedSQL: string;
  executedSQL: string; // Actual SQL that worked
  result: { columns: string[]; rowCount: number };
  timestamp: Date;
  datasourceId: string;
  ontologyVersion: string;
}

/**
 * Collects training data from query executions for ontology improvement.
 * Stores successful query → SQL mappings for learning.
 */
export class TrainingDataCollector {
  private minIOStore: ReturnType<typeof getMinIOStore> | null = null;

  constructor() {
    this.minIOStore = getMinIOStore();
  }

  /**
   * Collect a training example from a successful query execution.
   */
  async collectExample(example: TrainingExample): Promise<void> {
    const logger = await getLogger();

    if (!this.minIOStore) {
      logger.warn('[TrainingDataCollector] MinIO store not available, skipping collection');
      return;
    }

    try {
      const path = `training/${example.datasourceId}/${example.ontologyVersion}/${example.timestamp.toISOString()}.json`;
      const content = JSON.stringify(example, null, 2);

      // Store in MinIO
      const store = this.minIOStore.createGenericStore('training');
      await store.put(path, content);

      logger.info('[TrainingDataCollector] Training example collected', {
        datasourceId: example.datasourceId,
        queryLength: example.naturalLanguageQuery.length,
        rowCount: example.result.rowCount,
        path,
      });
    } catch (error) {
      logger.error('[TrainingDataCollector] Failed to collect example', {
        error: error instanceof Error ? error.message : String(error),
        datasourceId: example.datasourceId,
      });
    }
  }

  /**
   * Get training dataset for a datasource.
   */
  async getTrainingDataset(
    datasourceId: string,
    ontologyVersion: string = '1.0.0',
    limit: number = 100,
  ): Promise<TrainingExample[]> {
    const logger = await getLogger();

    if (!this.minIOStore) {
      logger.warn('[TrainingDataCollector] MinIO store not available');
      return [];
    }

    try {
      const prefix = `training/${datasourceId}/${ontologyVersion}/`;
      const store = this.minIOStore.createGenericStore('training');
      const objects = await store.list(prefix);

      const examples: TrainingExample[] = [];

      // Sort by timestamp (newest first) and limit
      const sorted = objects
        .sort((a, b) => (b.lastModified?.getTime() || 0) - (a.lastModified?.getTime() || 0))
        .slice(0, limit);

      for (const obj of sorted) {
        try {
          const content = await store.get(obj.key);
          if (content) {
            const example = JSON.parse(content) as TrainingExample;
            // Ensure timestamp is a Date object
            example.timestamp = new Date(example.timestamp);
            examples.push(example);
          }
        } catch (parseError) {
          logger.warn('[TrainingDataCollector] Failed to parse training example', {
            key: obj.key,
            error: parseError instanceof Error ? parseError.message : String(parseError),
          });
        }
      }

      logger.info('[TrainingDataCollector] Retrieved training dataset', {
        datasourceId,
        ontologyVersion,
        examplesCount: examples.length,
      });

      return examples;
    } catch (error) {
      logger.error('[TrainingDataCollector] Failed to get training dataset', {
        error: error instanceof Error ? error.message : String(error),
        datasourceId,
      });
      return [];
    }
  }

  /**
   * Delete old training examples (cleanup).
   */
  async cleanupOldExamples(
    datasourceId: string,
    ontologyVersion: string,
    olderThanDays: number = 30,
  ): Promise<number> {
    const logger = await getLogger();

    if (!this.minIOStore) {
      return 0;
    }

    try {
      const prefix = `training/${datasourceId}/${ontologyVersion}/`;
      const store = this.minIOStore.createGenericStore('training');
      const objects = await store.list(prefix);

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      let deletedCount = 0;

      for (const obj of objects) {
        if (obj.lastModified && obj.lastModified < cutoffDate) {
          await store.delete(obj.key);
          deletedCount++;
        }
      }

      logger.info('[TrainingDataCollector] Cleaned up old examples', {
        datasourceId,
        deletedCount,
        olderThanDays,
      });

      return deletedCount;
    } catch (error) {
      logger.error('[TrainingDataCollector] Failed to cleanup examples', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }
}

// Singleton instance
let collectorInstance: TrainingDataCollector | null = null;

export function getTrainingDataCollector(): TrainingDataCollector {
  if (!collectorInstance) {
    collectorInstance = new TrainingDataCollector();
  }
  return collectorInstance;
}
