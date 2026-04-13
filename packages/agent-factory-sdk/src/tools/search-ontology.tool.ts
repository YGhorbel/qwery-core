import { z } from 'zod';
import { Tool } from './tool';
import { getLogger } from '@qwery/shared/logger';
import { getExtra, resolveDatasourceId } from './tool-utils';

export const SearchOntologyTool = Tool.define('search_ontology', {
  description: `Search the semantic ontology index of a datasource for datasets relevant to a query.
Returns dataset names, descriptions, and field summaries.
Use before ask_data when you need to understand what data is available, or to validate that relevant datasets exist.`,

  parameters: z.object({
    datasourceId: z.string().describe('ID of the datasource'),
    query: z.string().describe('Topic or question to search for'),
    topK: z
      .number()
      .min(1)
      .max(20)
      .optional()
      .default(5)
      .describe('Max number of datasets to return'),
  }),

  async execute(args, ctx) {
    const logger = await getLogger();
    const { ontologyService } = await import('@qwery/semantic-layer/ontology');
    const { attachedDatasources } = getExtra(ctx);
    const datasourceId = resolveDatasourceId(
      args.datasourceId,
      attachedDatasources,
    );

    logger.info('[SearchOntologyTool] Searching ontology', {
      datasourceId,
      query: args.query,
      topK: args.topK ?? 5,
    });

    const results = await ontologyService.searchDatasets(
      datasourceId,
      args.query,
      args.topK ?? 5,
    );

    logger.info('[SearchOntologyTool] Results', {
      datasourceId,
      count: results.length,
      datasets: results.map((r) => r.name),
    });

    if (results.length === 0) {
      return {
        output:
          'No datasets found. The ontology index may not be built yet (Stage 3 required).',
      };
    }

    return {
      output: results
        .map(
          (r) =>
            `### ${r.name} (score: ${r.score.toFixed(3)})\n${r.description}\nSource: ${r.source}`,
        )
        .join('\n\n'),
    };
  },
});
