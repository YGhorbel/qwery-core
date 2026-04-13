import { HumanMessage } from '@langchain/core/messages';

import { discoveryService } from '../../../discovery.service';
import { getChatModel, extractJsonFromText } from '../../../llm';
import type { OSIDataset, OSIMetric } from '../../../osi/types';
import type { DiscoveredColumn, DiscoveredTable } from '../../../types';
import type { AgentStateType } from '../state';

const CONCURRENCY = Math.min(
  Math.max(1, Number(process.env['SEMANTIC_MODEL_CONCURRENCY'] ?? 5)),
  20,
);

function buildPrompt(
  table: DiscoveredTable,
  sampleRows: unknown[][],
  sampleCols: string[],
  instructions?: string,
): string {
  const columnList = table.columns
    .map(
      (c) =>
        `- ${c.name} (${c.dataType}${c.isPrimaryKey ? ', PK' : ''}${c.isNullable ? ', nullable' : ''})`,
    )
    .join('\n');

  const samplePreview =
    sampleRows.length > 0
      ? `Columns: ${sampleCols.join(', ')}\n` +
        sampleRows
          .slice(0, 5)
          .map((r) => r.join(' | '))
          .join('\n')
      : 'No sample data available.';

  return `You are a data semantic layer expert. Generate a semantic dataset descriptor for the following database table.

Table: ${table.schema}.${table.name}
Type: ${table.type}

Columns:
${columnList}

Sample data:
${samplePreview}
${instructions ? `\nBusiness context: ${instructions}` : ''}

Return a JSON object with this exact structure:
{
  "dataset": {
    "name": "<snake_case dataset name>",
    "source": "${table.schema}.${table.name}",
    "label": "<human-readable label>",
    "primary_key": ["<pk column name>"],
    "description": "<meaningful business description, 1-2 sentences>",
    "ai_context": {
      "synonyms": ["<5+ synonyms/alternative names>"],
      "instructions": "<how an AI should use this dataset>"
    },
    "fields": [
      {
        "name": "<column name>",
        "expression": { "dialects": [{ "dialect": "ANSI_SQL", "expression": "<column name>" }] },
        "label": "<human-readable label>",
        "description": "<what this field represents>",
        "dimension": { "is_time": <true if date/timestamp, false otherwise> },
        "ai_context": {
          "synonyms": ["<3+ synonyms>"],
          "data_type": "<actual data type>",
          "is_primary_key": <true/false>
        }
      }
    ]
  },
  "metrics": [
    {
      "name": "<snake_case metric name>",
      "expression": { "dialects": [{ "dialect": "ANSI_SQL", "expression": "<SQL expression using ${table.schema}.${table.name}.column>" }] },
      "description": "<what this metric measures>"
    }
  ]
}

Rules:
- Include ALL columns as fields
- Generate SUM/AVG/COUNT metrics for numeric columns (price, amount, quantity, etc.)
- Mark dimension.is_time as true for date/timestamp columns
- Provide at least 5 synonyms for the dataset and 3 for each field
- Make descriptions business-meaningful, not just restate the column name
- Return only valid JSON, no extra text`;
}

interface LlmDatasetOutput {
  dataset: OSIDataset;
  metrics: OSIMetric[];
}

async function processTable(
  table: DiscoveredTable,
  driverId: string,
  config: Record<string, unknown>,
  instructions: string | undefined,
): Promise<{ dataset: OSIDataset; metrics: OSIMetric[] } | null> {
  try {
    const sampleData = await discoveryService
      .getSampleData(
        driverId,
        config,
        { schema: table.schema, table: table.name },
        5,
      )
      .catch(() => ({ columns: [], rows: [] }));

    const prompt = buildPrompt(
      table,
      sampleData.rows,
      sampleData.columns,
      instructions,
    );
    const llm = getChatModel();
    const response = await llm.invoke([new HumanMessage(prompt)]);
    const text =
      typeof response.content === 'string'
        ? response.content
        : String(response.content);

    const parsed = extractJsonFromText(text) as LlmDatasetOutput;

    // Inject authoritative type info from actual schema (don't trust LLM for this)
    const colMap = new Map<string, DiscoveredColumn>(
      table.columns.map((c) => [c.name, c]),
    );
    if (parsed.dataset.fields) {
      for (const field of parsed.dataset.fields) {
        const col = colMap.get(field.name);
        if (col && field.ai_context && typeof field.ai_context === 'object') {
          (field.ai_context as Record<string, unknown>)['data_type'] =
            col.dataType;
          (field.ai_context as Record<string, unknown>)['is_primary_key'] =
            col.isPrimaryKey;
        }
      }
    }

    return { dataset: parsed.dataset, metrics: parsed.metrics ?? [] };
  } catch (err) {
    const { getLogger } = await import('@qwery/shared/logger');
    const logger = await getLogger();
    logger.warn(
      { table: `${table.schema}.${table.name}`, err },
      'semantic-layer: table generation failed',
    );
    return null;
  }
}

export async function discoverAndGenerateNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const { schema, driverId, config, instructions } = state;
  const tables = schema.tables;

  const datasets: OSIDataset[] = [];
  const tableMetrics: OSIMetric[][] = [];
  const failedTables: string[] = [];

  // Process in batches respecting concurrency limit
  for (let i = 0; i < tables.length; i += CONCURRENCY) {
    const batch = tables.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((t) => processTable(t, driverId, config, instructions)),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j]!;
      const table = batch[j]!;
      const tableKey = `${table.schema}.${table.name}`;

      if (result.status === 'fulfilled' && result.value !== null) {
        datasets.push(result.value.dataset);
        tableMetrics.push(result.value.metrics);
      } else {
        failedTables.push(tableKey);
      }
    }
  }

  return { datasets, tableMetrics, failedTables };
}
