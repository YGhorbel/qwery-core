import { z } from 'zod';
import { Tool } from './tool';
import { getLogger } from '@qwery/shared/logger';
import { Repositories } from '@qwery/domain/repositories';
import {
  ExtensionsRegistry,
  type DatasourceExtension,
} from '@qwery/extensions-sdk';
import { getDriverInstance } from '@qwery/extensions-loader';
import { loadMappings } from '@qwery/semantic-layer/mapping/store';
import { loadOntology } from '@qwery/semantic-layer/ontology/loader';

const DESCRIPTION = `Get the semantic schema for a datasource, including ontology concepts and their mappings to tables/columns.
Returns both the ontology structure and the mappings between the datasource and ontology.

Use this tool to check if a datasource has ontology and mappings available before deciding whether to use runSemanticQuery or runQuery.
If this tool returns a schema with concepts, the datasource is ready for semantic queries.`;

export const GetSemanticSchemaTool = Tool.define('getSemanticSchema', {
  description: DESCRIPTION,
  parameters: z.object({
    datasourceId: z
      .string()
      .optional()
      .describe('The ID of the datasource. If not provided, uses the attached datasource.'),
    ontologyVersion: z
      .string()
      .default('1.0.0')
      .describe('The ontology version to retrieve'),
  }),
  async execute(params, ctx) {
    const logger = await getLogger();
    const { repositories, attachedDatasources } = ctx.extra as {
      repositories: Repositories;
      attachedDatasources: string[];
    };

    const datasourceId = params.datasourceId ?? attachedDatasources[0];

    if (!datasourceId) {
      throw new Error('No datasource ID provided and no attached datasource found');
    }

    logger.debug('[GetSemanticSchemaTool] Retrieving semantic schema', {
      datasourceId,
      ontologyVersion: params.ontologyVersion,
    });

    // Try findById first, then findBySlug if not found (handles both UUIDs and slugs)
    let datasource = await repositories.datasource.findById(datasourceId);
    if (!datasource) {
      datasource = await repositories.datasource.findBySlug(datasourceId);
    }
    if (!datasource) {
      throw new Error(`Datasource not found: ${datasourceId}`);
    }

    if (datasource.datasource_provider !== 'postgresql') {
      throw new Error(
        `Semantic layer currently only supports PostgreSQL datasources. Got: ${datasource.datasource_provider}`,
      );
    }

    const extension = ExtensionsRegistry.get(
      datasource.datasource_provider,
    ) as DatasourceExtension | undefined;

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

    const driverInstance = await getDriverInstance(nodeDriver, {
      config: datasource.config,
    });

    try {
      // Use datasource.id (UUID) instead of datasourceId (which might be a slug)
      const actualDatasourceId = datasource.id;
      const ontologyVersion = params.ontologyVersion || '1.0.0';
      
      // Try datasource-specific ontology first, then fallback to default
      let ontology = await loadOntology(`datasource-${actualDatasourceId}/${ontologyVersion}`);
      if (!ontology) {
        ontology = await loadOntology(ontologyVersion);
      }
      
      if (!ontology) {
        throw new Error(
          `Ontology version ${ontologyVersion} not found for datasource ${actualDatasourceId}. Please ensure ontology is built and stored in MinIO.`,
        );
      }

      // Use actual datasource ID (UUID) for loading mappings
      const mappings = await loadMappings(
        actualDatasourceId,
        ontologyVersion,
      );

      const hasOntology = ontology !== null;
      const hasMappings = mappings.length > 0;
      const readyForSemanticQueries = hasOntology && hasMappings;

      return {
        ontology: {
          version: ontologyVersion,
          concepts: ontology.ontology.concepts.map((c) => ({
            id: c.id,
            label: c.label,
            description: c.description,
            properties: c.properties,
            relationships: c.relationships,
          })),
          inheritance: ontology.ontology.inheritance,
        },
        mappings: mappings.map((m) => ({
          table_schema: m.table_schema,
          table_name: m.table_name,
          concept_id: m.concept_id,
          confidence: m.confidence,
          synonyms: m.synonyms,
          column_mappings: m.column_mappings,
        })),
        summary: {
          totalConcepts: ontology.ontology.concepts.length,
          totalMappings: mappings.length,
          mappedTables: mappings.length,
          totalColumnMappings: mappings.reduce(
            (sum, m) => sum + m.column_mappings.length,
            0,
          ),
        },
        availability: {
          hasOntology,
          hasMappings,
          readyForSemanticQueries,
          ontologyVersion,
          recommendation: readyForSemanticQueries
            ? 'Use runSemanticQuery for natural language queries'
            : hasOntology
              ? 'Ontology available but mappings missing. Consider generating mappings first.'
              : 'No ontology available. Use runQuery for direct SQL queries.',
        },
      };
    } finally {
      if (typeof driverInstance.close === 'function') {
        await driverInstance.close();
      }
    }
  },
});
