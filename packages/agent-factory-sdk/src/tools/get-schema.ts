import { z } from 'zod';
import { Tool } from './tool';
import { getExtra } from './tool-utils';

const DESCRIPTION = `Get schema information (datasets, fields, relationships) for the attached datasource from the semantic ontology index.
Use detailLevel="simple" (default) to return dataset names and descriptions (token efficient).
Use detailLevel="full" for complete field-level details and relationship graph.
Falls back with a clear message if the ontology index has not been built yet (run Stage 1 → 2 → 3 from the Schema page).`;

function formatFields(fieldsJson: string): string {
  try {
    type OSIField = {
      name: string;
      ai_context?: unknown;
      dimension?: { is_time: boolean };
      description?: string;
    };
    const fields = JSON.parse(fieldsJson) as OSIField[];
    return fields
      .map((f) => {
        const aiCtx =
          f.ai_context && typeof f.ai_context === 'object'
            ? (f.ai_context as Record<string, unknown>)
            : {};
        const dataType =
          (aiCtx['data_type'] as string | undefined) ?? 'unknown';
        const isPk = Boolean(aiCtx['is_primary_key']);
        const parts: string[] = [`  - ${f.name}: ${dataType}`];
        if (isPk) parts.push('[PK]');
        if (f.dimension?.is_time) parts.push('[time]');
        if (f.description) parts.push(`— ${f.description}`);
        return parts.join(' ');
      })
      .join('\n');
  } catch {
    return '  (field details unavailable)';
  }
}

export const GetSchemaTool = Tool.define('getSchema', {
  description: DESCRIPTION,
  parameters: z.object({
    detailLevel: z
      .enum(['simple', 'full'])
      .default('simple')
      .describe(
        'Schema verbosity: "simple" for dataset names + descriptions, "full" for complete field details',
      ),
  }),

  async execute(params, ctx) {
    const { ontologyService } = await import('@qwery/semantic-layer/ontology');
    const { repositories, attachedDatasources } = getExtra(ctx);

    if (!attachedDatasources?.length) {
      throw new Error('No datasources attached');
    }

    const output: string[] = [];

    for (const datasourceId of attachedDatasources) {
      const datasource = await repositories.datasource.findById(datasourceId);
      const datasourceName =
        datasource?.name ?? datasource?.slug ?? datasourceId;

      const ontologyStatus =
        await ontologyService.getOntologyStatus(datasourceId);
      if (!ontologyStatus || ontologyStatus.status !== 'ready') {
        const status = ontologyStatus?.status ?? 'not_started';
        output.push(
          `## ${datasourceName}\n` +
            `Ontology index not ready (status: ${status}).\n` +
            `Run Stage 1 → Stage 2 → Stage 3 from the Schema page to build the semantic index.\n` +
            `Once ready, this tool returns AI-enriched dataset and field descriptions.`,
        );
        continue;
      }

      if (params.detailLevel === 'simple') {
        const datasets = await ontologyService.listDatasets(datasourceId);
        if (datasets.length === 0) {
          output.push(
            `## ${datasourceName}\nNo datasets found in ontology index.`,
          );
          continue;
        }
        const lines = [`## ${datasourceName} (${datasets.length} datasets)`];
        for (const d of datasets) {
          lines.push(`- **${d.name}** (${d.source}): ${d.description || '—'}`);
        }
        output.push(lines.join('\n'));
      } else {
        const datasets = await ontologyService.listDatasets(datasourceId);
        if (datasets.length === 0) {
          output.push(
            `## ${datasourceName}\nNo datasets found in ontology index.`,
          );
          continue;
        }

        const details = await ontologyService.searchDatasets(
          datasourceId,
          datasets.map((d) => d.name).join(' '),
          datasets.length,
        );
        const detailMap = new Map(details.map((d) => [d.name, d]));
        const relationships =
          await ontologyService.getRelationships(datasourceId);

        const lines = [`## ${datasourceName} (${datasets.length} datasets)`];
        for (const dataset of datasets) {
          lines.push(`\n### ${dataset.name} (source: ${dataset.source})`);
          if (dataset.description) lines.push(dataset.description);
          const detail = detailMap.get(dataset.name);
          if (detail?.fields) lines.push(formatFields(detail.fields));
        }

        if (relationships.length > 0) {
          lines.push('\n### Relationships');
          for (const r of relationships) {
            lines.push(
              `- ${r.fromDataset}.${r.fromColumns.join(',')} → ${r.toDataset}.${r.toColumns.join(',')} (${r.name})`,
            );
          }
        }

        output.push(lines.join('\n'));
      }
    }

    return { output: output.join('\n\n') };
  },
});
