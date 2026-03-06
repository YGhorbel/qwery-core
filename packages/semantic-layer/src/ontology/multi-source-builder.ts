import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { DualLayerOntology } from '../models/ontology.schema';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { LanguageModel } from 'ai';
import type { MappingResult } from '../mapping/generator';
import { buildAbstractLayer } from './abstract-layer';
import { buildConcreteLayer, createLayerMappings } from './concrete-layer';
import { getVersionManager } from './version-manager';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface MultiSourceInput {
  datasourceId: string;
  metadata: DatasourceMetadata;
  ontology: {
    ontology: {
      concepts: Array<{
        id: string;
        label: string;
        description?: string;
        properties: Array<{
          id: string;
          label: string;
          type: string;
          description?: string;
        }>;
        relationships: Array<{
          target: string;
          type: string;
          label: string;
          description?: string;
        }>;
      }>;
    };
  };
  mappings: MappingResult;
}

/**
 * Build ontology from multiple datasources.
 * Creates unified abstract layer and maps multiple concrete layers.
 */
export async function buildMultiSourceOntology(
  datasources: MultiSourceInput[],
  languageModel: LanguageModel,
  version: string = '1.0.0',
): Promise<DualLayerOntology> {
  const logger = await getLogger();

  logger.info('[MultiSourceBuilder] Building multi-source ontology', {
    datasourcesCount: datasources.length,
    version,
  });

  // Extract concepts from each datasource ontology
  const datasourceOntologies = datasources.map((ds) => ({
    datasourceId: ds.datasourceId,
    concepts: ds.ontology.ontology.concepts,
  }));

  // Build unified abstract layer
  const abstractLayer = await buildAbstractLayer(datasourceOntologies, languageModel);

  // Build concrete layers for each datasource
  const concreteLayers = datasources.map((ds) =>
    buildConcreteLayer(ds.datasourceId, ds.metadata, ds.mappings),
  );

  // Create mappings between abstract and concrete layers
  const mappings = createLayerMappings(abstractLayer.concepts, concreteLayers);

  // Build concrete layer map
  const concreteMap: Record<string, typeof concreteLayers[0]> = {};
  for (const layer of concreteLayers) {
    concreteMap[layer.datasourceId] = {
      datasourceId: layer.datasourceId,
      tableMappings: layer.tableMappings,
      columnMappings: layer.columnMappings,
      relationships: layer.relationships,
    };
  }

  logger.info('[MultiSourceBuilder] Multi-source ontology built', {
    abstractConceptsCount: abstractLayer.concepts.length,
    abstractRelationshipsCount: abstractLayer.relationships.length,
    concreteLayersCount: concreteLayers.length,
    mappingsCount: Object.keys(mappings.abstractToConcrete).length,
  });

  return {
    abstract: abstractLayer,
    concrete: concreteMap,
    mappings,
    version,
  };
}
