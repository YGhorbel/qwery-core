import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { NeoOntologyService } from '../../../ontology/neo-ontology.service';

export function createListDatasetsTool(
  neoOntologyService: NeoOntologyService,
  datasourceId: string,
) {
  return new DynamicStructuredTool({
    name: 'list_datasets',
    description:
      'List all datasets available in the ontology for this datasource.',
    schema: z.object({}),
    func: async () => {
      const datasets = await neoOntologyService.listDatasets(datasourceId);
      if (datasets.length === 0) return 'No datasets found in ontology.';
      const lines = datasets.map(
        (d) =>
          `- **${d.name}** (${d.label}): ${d.description} [source: ${d.source}]`,
      );
      return `${datasets.length} datasets available:\n\n${lines.join('\n')}`;
    },
  });
}
