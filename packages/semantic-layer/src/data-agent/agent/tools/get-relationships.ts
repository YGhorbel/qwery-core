import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { NeoOntologyService } from '../../../ontology/neo-ontology.service';

export function createGetRelationshipsTool(
  neoOntologyService: NeoOntologyService,
  datasourceId: string,
) {
  return new DynamicStructuredTool({
    name: 'get_relationships',
    description:
      'Get all join relationships (RELATES_TO edges) between datasets in the ontology.',
    schema: z.object({}),
    func: async () => {
      const relationships =
        await neoOntologyService.getRelationships(datasourceId);
      if (relationships.length === 0)
        return 'No relationships found in ontology.';
      const lines = relationships.map((r) => {
        const joinOn = r.fromColumns
          .map(
            (fc, i) =>
              `${r.fromDataset}.${fc} = ${r.toDataset}.${r.toColumns[i] ?? ''}`,
          )
          .join(', ');
        return `- **${r.fromDataset}** → **${r.toDataset}** (${r.name})\n  JOIN ON: ${joinOn}`;
      });
      return `${relationships.length} relationships found:\n\n${lines.join('\n\n')}`;
    },
  });
}
