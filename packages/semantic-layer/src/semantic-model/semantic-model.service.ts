import { getLogger } from '@qwery/shared/logger';

import type { OSISemanticModel } from '../osi/types';
import {
  loadDiscoveryRecord,
  loadOsiModel,
  saveSemanticModelStatusRecord,
  loadSemanticModelStatusRecord,
} from '../schema-store';
import type { SemanticModelStatusRecord } from '../types';
import { buildSemanticModelGraph } from './agent/graph';

export class SemanticModelService {
  async generateModel(
    datasourceId: string,
    datasourceName: string,
    driverId: string,
    config: Record<string, unknown>,
    instructions?: string,
  ): Promise<{ semanticModelId: string; model: OSISemanticModel }> {
    const logger = await getLogger();

    const record = await loadDiscoveryRecord(datasourceId);
    if (!record?.schema) {
      throw new Error(
        `No discovered schema found for datasource ${datasourceId}. Run schema discovery first.`,
      );
    }

    await saveSemanticModelStatusRecord({
      datasourceId,
      status: 'running',
      updatedAt: new Date().toISOString(),
      generatedAt: null,
      error: null,
    });

    logger.info(
      { datasourceId, tables: record.schema.tables.length },
      'semantic-layer: starting semantic model generation',
    );

    try {
      const graph = buildSemanticModelGraph();

      const finalState = await graph.invoke({
        datasourceId,
        datasourceName,
        schema: record.schema,
        driverId,
        config,
        instructions,
      });

      if (!finalState.semanticModelId || !finalState.semanticModel) {
        throw new Error('Semantic model generation failed — no model produced');
      }

      const generatedAt = new Date().toISOString();
      await saveSemanticModelStatusRecord({
        datasourceId,
        status: 'ready',
        updatedAt: generatedAt,
        generatedAt,
        error: null,
      });

      logger.info(
        {
          datasourceId,
          semanticModelId: finalState.semanticModelId,
          datasets: finalState.datasets.length,
          relationships: finalState.relationships.length,
          failedTables: finalState.failedTables,
        },
        'semantic-layer: semantic model generation complete',
      );

      return {
        semanticModelId: finalState.semanticModelId,
        model: finalState.semanticModel,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await saveSemanticModelStatusRecord({
        datasourceId,
        status: 'failed',
        updatedAt: new Date().toISOString(),
        generatedAt: null,
        error: message,
      });
      throw err;
    }
  }

  async getModel(datasourceId: string): Promise<OSISemanticModel | null> {
    const record = await loadOsiModel(datasourceId);
    return record?.model ?? null;
  }

  async getStatus(
    datasourceId: string,
  ): Promise<SemanticModelStatusRecord | null> {
    return loadSemanticModelStatusRecord(datasourceId);
  }
}

export const semanticModelService = new SemanticModelService();
