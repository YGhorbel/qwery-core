import { z } from 'zod';
import { Tool } from './tool';
import { getLogger } from '@qwery/shared/logger';
import { Repositories } from '@qwery/domain/repositories';
import { loadOntology } from '@qwery/semantic-layer/ontology/loader';
import { buildOntologySchemaView } from '@qwery/semantic-layer/schema/ontology-schema-view';
import type { DatasourceExtension } from '@qwery/extensions-sdk';

const DESCRIPTION = `Get ontology-based schema information for a datasource.
Returns semantic concepts, properties, and relationships from the ontology instead of raw database metadata.
This provides a business-friendly, semantic view of the datasource structure.`;

export const GetSchemaTool = Tool.define('getSchema', {
  description: DESCRIPTION,
  parameters: z.object({
    ontologyVersion: z.string().optional().describe('Ontology version to use (default: 1.0.0)'),
  }),
  async execute(params, ctx) {
    const logger = await getLogger();
    const { repositories, attachedDatasources } = ctx.extra as {
      repositories: Repositories;
      attachedDatasources: string[];
    };

    logger.info('[GetSchemaTool] Tool execution (ontology-based):', {
      attachedDatasources,
      ontologyVersion: params.ontologyVersion,
    });

    const datasourceId = attachedDatasources[0];
    if (!datasourceId) {
      throw new Error('No datasource attached');
    }

    // Try findById first, then findBySlug if not found (handles both UUIDs and slugs)
    let datasource = await repositories.datasource.findById(datasourceId);
    if (!datasource) {
      datasource = await repositories.datasource.findBySlug(datasourceId);
    }
    if (!datasource) {
      throw new Error(`Datasource not found: ${datasourceId}`);
    }

    // Try datasource-specific ontology first, then fallback to default
    const ontologyVersion = params.ontologyVersion || '1.0.0';
    let ontology = await loadOntology(`datasource-${datasourceId}/${ontologyVersion}`);
    
    if (!ontology) {
      ontology = await loadOntology(ontologyVersion);
    }

    if (!ontology) {
      logger.warn('[GetSchemaTool] Ontology not found, falling back to raw metadata', {
        datasourceId,
        ontologyVersion,
      });
      
      // Fallback to raw metadata if ontology not available
      const { ExtensionsRegistry } = await import('@qwery/extensions-sdk');
      const { getDriverInstance } = await import('@qwery/extensions-loader');
      
      const extension = ExtensionsRegistry.get(datasource.datasource_provider) as
        | DatasourceExtension
        | undefined;
      if (!extension?.drivers?.length) {
        throw new Error(
          `No driver found for provider: ${datasource.datasource_provider}`,
        );
      }

      const nodeDriver =
        extension.drivers.find((d) => d.runtime === 'node') ??
        extension.drivers[0];
      if (!nodeDriver) {
        throw new Error(
          `No node driver for provider: ${datasource.datasource_provider}`,
        );
      }

      const instance = await getDriverInstance(nodeDriver, {
        config: datasource.config,
      });

      try {
        const metadata = await instance.metadata();
        return {
          schema: metadata,
          isRawMetadata: true,
        };
      } finally {
        if (typeof instance.close === 'function') {
          await instance.close();
        }
      }
    }

    // Build ontology-based schema view
    const schemaView = await buildOntologySchemaView(
      ontology,
      datasourceId,
      ontologyVersion,
    );

    logger.info('[GetSchemaTool] Ontology schema view built', {
      conceptsCount: schemaView.concepts.length,
      totalProperties: schemaView.concepts.reduce((sum, c) => sum + c.properties.length, 0),
      totalRelationships: schemaView.concepts.reduce((sum, c) => sum + c.relationships.length, 0),
    });

    return {
      schema: schemaView,
      isRawMetadata: false,
      ontologyVersion,
    };
  },
});
