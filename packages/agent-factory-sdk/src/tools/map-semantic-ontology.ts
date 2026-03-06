import { z } from 'zod';
import { Tool } from './tool';
import { getLogger } from '@qwery/shared/logger';
import { Repositories } from '@qwery/domain/repositories';
import {
  ExtensionsRegistry,
  type DatasourceExtension,
} from '@qwery/extensions-sdk';
import { getDriverInstance } from '@qwery/extensions-loader';
import { generateMappings } from '@qwery/semantic-layer/mapping/generator';
import { storeMappings } from '@qwery/semantic-layer/mapping/store';
import { loadOntology } from '@qwery/semantic-layer/ontology/loader';
import { Provider } from '../llm';

const DESCRIPTION = `Generate semantic mappings between a datasource schema and the ontology.
This tool analyzes the datasource schema and creates mappings from tables/columns to ontology concepts/properties using GPT for reasoning.`;

export const MapSemanticOntologyTool = Tool.define('mapSemanticOntology', {
  description: DESCRIPTION,
  parameters: z.object({
    datasourceId: z
      .string()
      .optional()
      .describe('The ID of the datasource to map. If not provided, uses the attached datasource.'),
    ontologyVersion: z
      .string()
      .default('1.0.0')
      .describe('The ontology version to use for mapping'),
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

    logger.debug('[MapSemanticOntologyTool] Starting mapping generation', {
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
      const metadata = await driverInstance.metadata();

      const ontology = await loadOntology(params.ontologyVersion);
      if (!ontology) {
        throw new Error(
          `Ontology version ${params.ontologyVersion} not found. Please upload ontology to MinIO.`,
        );
      }

      logger.info('[MapSemanticOntologyTool] Generating mappings with GPT');

      const modelName =
        typeof process !== 'undefined'
          ? process.env.AZURE_OPENAI_DEPLOYMENT ||
            process.env.VITE_AZURE_OPENAI_DEPLOYMENT ||
            'gpt-5.2-chat'
          : 'gpt-5.2-chat';
      const model = Provider.getModel('azure', modelName);
      const languageModel = await Provider.getLanguage(model);
      const mappings = await generateMappings(metadata, ontology, languageModel);

      logger.info('[MapSemanticOntologyTool] Storing mappings', {
        tableCount: mappings.table_mappings.length,
      });

      const result = await storeMappings(
        datasourceId,
        params.ontologyVersion,
        mappings,
      );

      return {
        success: true,
        datasourceId,
        ontologyVersion: params.ontologyVersion,
        tableMappingsCreated: result.tableMappingsCreated,
        columnMappingsCreated: result.columnMappingsCreated,
        summary: `Created ${result.tableMappingsCreated} table mappings and ${result.columnMappingsCreated} column mappings`,
      };
    } finally {
      if (typeof driverInstance.close === 'function') {
        await driverInstance.close();
      }
    }
  },
});
