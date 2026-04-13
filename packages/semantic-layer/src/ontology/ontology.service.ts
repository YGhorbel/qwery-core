import { getLogger } from '@qwery/shared/logger';

import { loadOsiModel } from '../schema-store';
import { neoOntologyService } from './neo-ontology.service';
import { loadOntologyRecord, saveOntologyRecord } from './ontology-store';
import type { OntologyRecord } from './ontology-store';

export class OntologyService {
  async buildOntology(datasourceId: string): Promise<OntologyRecord> {
    const logger = await getLogger();

    await saveOntologyRecord({
      datasourceId,
      status: 'indexing',
      nodeCount: 0,
      relationshipCount: 0,
      datasetCount: 0,
      indexedAt: null,
      error: null,
    });

    try {
      const osiRecord = await loadOsiModel(datasourceId);
      if (!osiRecord?.model) {
        throw new Error(
          `No semantic model found for datasource ${datasourceId}. Run Stage 2 first.`,
        );
      }

      logger.info(
        { datasourceId },
        'semantic-layer: building Neo4j ontology graph',
      );

      const stats = await neoOntologyService.createGraph(
        datasourceId,
        osiRecord.model,
      );

      const record: OntologyRecord = {
        datasourceId,
        status: 'ready',
        nodeCount: stats.nodeCount,
        relationshipCount: stats.relationshipCount,
        datasetCount: stats.datasetCount,
        indexedAt: new Date().toISOString(),
        error: null,
      };

      await saveOntologyRecord(record);

      logger.info(
        { datasourceId, ...stats },
        'semantic-layer: ontology graph ready',
      );

      return record;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { datasourceId, err },
        'semantic-layer: ontology build failed',
      );

      const record: OntologyRecord = {
        datasourceId,
        status: 'failed',
        nodeCount: 0,
        relationshipCount: 0,
        datasetCount: 0,
        indexedAt: null,
        error: message,
      };

      await saveOntologyRecord(record);
      throw err;
    }
  }

  async getOntologyStatus(
    datasourceId: string,
  ): Promise<OntologyRecord | null> {
    return loadOntologyRecord(datasourceId);
  }

  async searchDatasets(datasourceId: string, query: string, topK = 5) {
    return neoOntologyService.searchSimilar(datasourceId, query, topK);
  }

  async listDatasets(datasourceId: string) {
    return neoOntologyService.listDatasets(datasourceId);
  }

  async getRelationships(datasourceId: string) {
    return neoOntologyService.getRelationships(datasourceId);
  }
}

export const ontologyService = new OntologyService();
