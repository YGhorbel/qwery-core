/**
 * Agent 04 — Metric Builder
 * Infers measures from numeric columns using LLM.
 * Also adds dimensions for non-numeric columns.
 */
import type { DatasourceMetadata } from '@qwery/domain/entities';
import { routeModel } from '@qwery/agent-factory-sdk';
import { chatComplete } from '../llm-client.js';
import type { LabelMap, MeasureDefinition, DimensionDefinition } from '../types.js';

const NUMERIC_TYPES = new Set([
  'integer', 'int', 'int2', 'int4', 'int8',
  'bigint', 'smallint', 'numeric', 'decimal',
  'float', 'float4', 'float8', 'double precision', 'real',
  'money', 'number',
]);

const DATE_TYPES = new Set([
  'date', 'timestamp', 'timestamptz', 'timestamp with time zone',
  'timestamp without time zone', 'datetime', 'time',
]);

function isNumeric(type: string): boolean {
  return NUMERIC_TYPES.has(type.toLowerCase().trim());
}

function isDate(type: string): boolean {
  return DATE_TYPES.has(type.toLowerCase().trim());
}

function inferFormat(
  columnName: string,
  avgValue?: number,
): MeasureDefinition['format'] {
  const name = columnName.toLowerCase();
  if (name.includes('pct') || name.includes('percent') || name.includes('rate'))
    return 'percent';
  if (
    name.includes('price') ||
    name.includes('revenue') ||
    name.includes('amount') ||
    name.includes('total') ||
    name.includes('cost') ||
    name.includes('fee') ||
    (avgValue !== undefined && avgValue > 10)
  )
    return 'currency_usd';
  return 'decimal';
}

type ColumnInfo = {
  table: string;
  column: string;
  type: string;
};

function buildWhenToUsePrompt(
  measures: Array<{ key: string; sql: string; table: string; label: string; columns: string[] }>,
): string {
  const list = measures
    .map((m) => `- ${m.key}: sql="${m.sql}", table="${m.table}", columns=[${m.columns.join(', ')}], label="${m.label}"`)
    .join('\n');
  return `You are writing usage guidance for a business analytics semantic layer.
For each measure below, write exactly 2 sentences explaining WHEN a business user should use it.
Be specific about which business questions it answers.

Return a JSON object keyed by "tableName.columnName":
{
  "orders.sale_price": "Use this metric to measure revenue from completed transactions. It answers questions like total sales, revenue by region, or monthly sales trends."
}

Measures:
${list}

Return only valid JSON.`;
}

function buildMeasurePrompt(batch: ColumnInfo[], labelMap: LabelMap): string {
  const colList = batch
    .map((c) => {
      const entry = labelMap[`${c.table}.${c.column}`];
      const label = entry?.label ?? c.column;
      const desc = entry?.description ?? '';
      return `- ${c.table}.${c.column} (${c.type}) → "${label}": ${desc}`;
    })
    .join('\n');

  return `You are defining SQL measures for a business analytics system.
For each numeric column below, define a measure with:
- "sql": the SQL aggregate expression (e.g. "SUM(sale_price)", "COUNT(*)", "AVG(response_time)")
- "filters": array of SQL WHERE conditions that should always be applied (e.g. ["status = 'complete'", "del_flag = 0"])
- "summable": true if this metric can be summed across rows, false if it's a rate/ratio

Return a JSON object keyed by "tableName.columnName":
{
  "orders.sale_price": {
    "sql": "SUM(sale_price)",
    "filters": ["status = 'complete'"],
    "summable": true
  }
}

Columns:
${colList}

Return only valid JSON.`;
}

export async function runMetricBuilder(
  metadata: DatasourceMetadata,
  labelMap: LabelMap,
): Promise<{
  measures: Record<string, MeasureDefinition>;
  dimensions: Record<string, DimensionDefinition>;
}> {
  const measures: Record<string, MeasureDefinition> = {};
  const dimensions: Record<string, DimensionDefinition> = {};

  const tableNames = new Map<number, string>();
  for (const t of metadata.tables ?? []) {
    tableNames.set(t.id, t.name);
  }

  const numericCols: ColumnInfo[] = [];

  for (const col of metadata.columns ?? []) {
    const table = tableNames.get(col.table_id);
    if (!table) continue;
    const colType = col.data_type ?? 'unknown';
    const key = `${table}.${col.name}`;
    const entry = labelMap[key];

    if (isNumeric(colType)) {
      numericCols.push({ table, column: col.name, type: colType });
    } else if (isDate(colType)) {
      dimensions[key] = {
        label: entry?.label ?? col.name.replace(/_/g, ' '),
        sql: `${table}.${col.name}`,
        table,
        type: 'date',
        synonyms: entry?.synonyms ?? [],
      };
    } else {
      // string / boolean dimension
      dimensions[key] = {
        label: entry?.label ?? col.name.replace(/_/g, ' '),
        sql: `${table}.${col.name}`,
        table,
        type: colType.toLowerCase().includes('bool') ? 'boolean' : 'string',
        synonyms: entry?.synonyms ?? [],
      };
    }
  }

  // Batch numeric columns through LLM
  const BATCH = 15;
  for (let i = 0; i < numericCols.length; i += BATCH) {
    const batch = numericCols.slice(i, i + BATCH);
    try {
      const response = await chatComplete(
        [{ role: 'user', content: buildMeasurePrompt(batch, labelMap) }],
        undefined,
        routeModel('sql_generation'),
      );
      const parsed = JSON.parse(response.trim()) as Record<
        string,
        { sql: string; filters: string[]; summable: boolean }
      >;

      for (const col of batch) {
        const key = `${col.table}.${col.column}`;
        const llmResult = parsed[key];
        const entry = labelMap[key];
        measures[key] = {
          label: entry?.label ?? col.column.replace(/_/g, ' '),
          description: entry?.description ?? '',
          sql: llmResult?.sql ?? `SUM(${col.column})`,
          filters: llmResult?.filters ?? [],
          format: inferFormat(col.column),
          table: col.table,
          synonyms: entry?.synonyms ?? [],
        };
      }

      // Second pass: generate when_to_use for each measure in the batch
      try {
        const whenInput = batch.map((col) => {
          const key = `${col.table}.${col.column}`;
          return {
            key,
            sql: measures[key]?.sql ?? `SUM(${col.column})`,
            table: col.table,
            label: measures[key]?.label ?? col.column,
            columns: [col.column],
          };
        });
        const whenResponse = await chatComplete(
          [{ role: 'user', content: buildWhenToUsePrompt(whenInput) }],
          { maxTokens: 1024 },
          routeModel('labeling'),
        );
        const whenParsed = JSON.parse(whenResponse.trim()) as Record<string, string>;
        for (const col of batch) {
          const key = `${col.table}.${col.column}`;
          if (whenParsed[key] && measures[key]) {
            measures[key]!.when_to_use = whenParsed[key];
          }
        }
      } catch {
        // when_to_use is optional — skip silently
      }
    } catch {
      // Fallback: create basic SUM measures for the batch
      for (const col of batch) {
        const key = `${col.table}.${col.column}`;
        const entry = labelMap[key];
        measures[key] = {
          label: entry?.label ?? col.column.replace(/_/g, ' '),
          description: entry?.description ?? '',
          sql: `SUM(${col.column})`,
          filters: [],
          format: inferFormat(col.column),
          table: col.table,
          synonyms: entry?.synonyms ?? [],
        };
      }
    }
  }

  return { measures, dimensions };
}
