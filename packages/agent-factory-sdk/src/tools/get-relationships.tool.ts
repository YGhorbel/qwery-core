import { z } from 'zod';
import { Tool } from './tool';
import { getLogger } from '@qwery/shared/logger';
import { getExtra, resolveDatasourceId } from './tool-utils';

export const GetRelationshipsTool = Tool.define('get_relationships', {
  description: `Get all join relationships between datasets in the semantic ontology of a datasource.
Returns from/to dataset names, join columns, and relationship names.
Use this after search_ontology to understand how to JOIN datasets when writing SQL.`,

  parameters: z.object({
    datasourceId: z.string().describe('ID of the datasource'),
  }),

  async execute(args, ctx) {
    const logger = await getLogger();
    const { ontologyService } = await import('@qwery/semantic-layer/ontology');
    const { attachedDatasources } = getExtra(ctx);
    const datasourceId = resolveDatasourceId(
      args.datasourceId,
      attachedDatasources,
    );

    logger.info('[GetRelationshipsTool] Fetching relationships', {
      datasourceId,
    });

    const relationships = await ontologyService.getRelationships(datasourceId);

    logger.info('[GetRelationshipsTool] Results', {
      datasourceId,
      count: relationships.length,
    });

    if (relationships.length === 0) {
      return {
        output:
          'No relationships found. Either the ontology is not built yet, or this datasource has no defined joins.',
      };
    }

    const lines = relationships.map(
      (r) =>
        `- **${r.fromDataset}** (${r.fromColumns.join(', ')}) → **${r.toDataset}** (${r.toColumns.join(', ')})  [${r.name}]`,
    );

    return { output: `## Dataset Relationships\n\n${lines.join('\n')}` };
  },
});
