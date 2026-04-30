/**
 * Agent 02 — Labeler
 * Takes schema.json and produces label_map.json:
 *   { "tableName.columnName": { label, description, synonyms[] } }
 *
 * Batches columns in groups of 20 to stay within token limits.
 */
import type { DatasourceMetadata } from '@qwery/domain/entities';
import { routeModel } from '@qwery/agent-factory-sdk';
import { chatComplete } from '../llm-client.js';
import type { LabelMap, LabelEntry } from '../types.js';

const BATCH_SIZE = 20;

type RawColumn = {
  table: string;
  column: string;
  dataType: string;
};

function extractColumns(metadata: DatasourceMetadata): RawColumn[] {
  const tableNames = new Map<number, string>();
  for (const t of metadata.tables ?? []) {
    tableNames.set(t.id, t.name);
  }

  const cols: RawColumn[] = [];
  for (const col of metadata.columns ?? []) {
    const table = tableNames.get(col.table_id) ?? col.schema ?? 'unknown';
    cols.push({
      table,
      column: col.name,
      dataType: col.data_type ?? 'unknown',
    });
  }
  return cols;
}

function buildPrompt(batch: RawColumn[]): string {
  const colList = batch
    .map((c) => `- ${c.table}.${c.column} (${c.dataType})`)
    .join('\n');

  return `You are mapping raw database column names to business-friendly labels.
For each column below, provide a JSON object with:
- "label": human-readable name (e.g. "Total Revenue" not "tot_rev_amt")
- "description": one sentence explaining what this column means
- "synonyms": array of 3-5 alternative terms a business user might say

Return a JSON object keyed by "tableName.columnName". Example:
{
  "orders.tot_rev_amt": {
    "label": "Total Revenue",
    "description": "The gross revenue amount for the order before discounts.",
    "synonyms": ["revenue", "sales", "income", "earnings", "turnover"]
  }
}

Columns to label:
${colList}

Return only valid JSON. No markdown, no explanation.`;
}

async function labelBatch(batch: RawColumn[]): Promise<LabelMap> {
  const response = await chatComplete(
    [{ role: 'user', content: buildPrompt(batch) }],
    undefined,
    routeModel('labeling'),
  );

  try {
    const parsed = JSON.parse(response.trim()) as Record<string, unknown>;
    const result: LabelMap = {};
    for (const [key, val] of Object.entries(parsed)) {
      const entry = val as Partial<LabelEntry>;
      const rawCol = key.includes('.') ? key.slice(key.indexOf('.') + 1) : key;
      result[key] = {
        label: entry.label ?? key,
        description: entry.description ?? '',
        synonyms: entry.synonyms ?? [],
        raw_column: rawCol,
      };
    }
    return result;
  } catch {
    const fallback: LabelMap = {};
    for (const col of batch) {
      const key = `${col.table}.${col.column}`;
      fallback[key] = {
        label: col.column.replace(/_/g, ' '),
        description: `Column ${col.column} in table ${col.table}`,
        synonyms: [],
        raw_column: col.column,
      };
    }
    return fallback;
  }
}

export async function runLabeler(metadata: DatasourceMetadata): Promise<LabelMap> {
  const columns = extractColumns(metadata);
  const labelMap: LabelMap = {};

  for (let i = 0; i < columns.length; i += BATCH_SIZE) {
    const batch = columns.slice(i, i + BATCH_SIZE);
    const batchResult = await labelBatch(batch);
    Object.assign(labelMap, batchResult);
  }

  return labelMap;
}
