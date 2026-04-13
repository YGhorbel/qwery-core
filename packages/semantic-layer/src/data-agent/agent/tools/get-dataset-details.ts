import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { NeoOntologyService } from '../../../ontology/neo-ontology.service';
import { fieldsToYaml } from '../../utils';

export function createGetDatasetDetailsTool(
  neoOntologyService: NeoOntologyService,
  datasourceId: string,
) {
  return new DynamicStructuredTool({
    name: 'get_dataset_details',
    description:
      'Get YAML schema and field details for one or more datasets by name.',
    schema: z.object({
      datasetNames: z
        .array(z.string())
        .describe('Names of datasets to retrieve'),
    }),
    func: async ({ datasetNames }) => {
      const results = await neoOntologyService.getDatasetDetails(
        datasourceId,
        datasetNames,
      );
      const sections: string[] = [];

      for (const name of datasetNames) {
        const detail = results.find((r) => r.name === name);
        if (!detail) {
          sections.push(`--- ${name} ---\nDataset not found in ontology.`);
        } else {
          sections.push(
            `--- ${detail.name} (${detail.source}) ---\n${detail.description}\n\`\`\`yaml\n${fieldsToYaml(detail.name, detail.source, detail.fields)}\n\`\`\``,
          );
        }
      }

      return sections.join('\n\n');
    },
  });
}
