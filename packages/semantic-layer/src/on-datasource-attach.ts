import type { Datasource } from '@qwery/domain/entities';
import type { IDatasourceRepository } from '@qwery/domain/repositories';
import { getLogger } from '@qwery/shared/logger';

import { discoveryService } from './discovery.service';
import { ontologyService } from './ontology/ontology.service';
import { semanticModelService } from './semantic-model/semantic-model.service';
import {
  loadDiscoveryRecord,
  saveDiscoveryRecord,
  saveSemanticModelStatusRecord,
  updateDiscoveryStatus,
} from './schema-store';

export async function onDatasourceAttach(
  datasource: Datasource,
  datasourceRepo: IDatasourceRepository,
): Promise<void> {
  const logger = await getLogger();
  const { id, datasource_provider, datasource_driver } = datasource;

  logger.info(
    { datasourceId: id, provider: datasource_provider },
    'semantic-layer: starting schema discovery',
  );

  await updateDiscoveryStatus(id, 'running');

  try {
    const revealedConfig = await datasourceRepo.revealSecrets(
      datasource.config,
    );

    const schema = await discoveryService.discoverSchema(
      id,
      datasource_provider,
      datasource_driver,
      revealedConfig,
    );

    await saveDiscoveryRecord({
      datasourceId: id,
      status: 'ready',
      updatedAt: new Date().toISOString(),
      error: null,
      schema,
    });

    logger.info(
      {
        datasourceId: id,
        tables: schema.tables.length,
        foreignKeys: schema.foreignKeys.length,
      },
      'semantic-layer: schema discovery complete',
    );

    // Stage 2 + 3 — generate semantic model then build ontology (fire-and-forget)
    await saveSemanticModelStatusRecord({
      datasourceId: id,
      status: 'pending',
      updatedAt: new Date().toISOString(),
      generatedAt: null,
      error: null,
    });

    semanticModelService
      .generateModel(
        id,
        datasource.name ?? datasource_provider,
        datasource_driver,
        revealedConfig,
      )
      .then(() =>
        ontologyService.buildOntology(id).catch((err: unknown) => {
          logger.warn(
            { datasourceId: id, err },
            'semantic-layer: ontology build failed',
          );
        }),
      )
      .catch((err: unknown) => {
        logger.warn(
          { datasourceId: id, err },
          'semantic-layer: semantic model generation failed',
        );
      });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { datasourceId: id, err },
      'semantic-layer: schema discovery failed',
    );
    await updateDiscoveryStatus(id, 'failed', message);
  }
}

export async function getDiscoveryStatus(datasourceId: string) {
  return loadDiscoveryRecord(datasourceId);
}
