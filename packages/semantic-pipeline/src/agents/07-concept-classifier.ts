/**
 * Agent 07 — Concept Classifier
 * Maps tables to semantic concept classes (Person, Transaction, Product, etc.)
 */
import type { DatasourceMetadata } from '@qwery/domain/entities';
import { routeModel, extractR1Response } from '@qwery/agent-factory-sdk';
import { chatComplete } from '../llm-client.js';
import type { ConceptDefinition } from '../types.js';

const CONCEPT_TAXONOMY = [
  'Person',
  'Transaction',
  'Product',
  'Event',
  'Location',
  'Organization',
  'TimeFrame',
  'Other',
] as const;

type ConceptClass = (typeof CONCEPT_TAXONOMY)[number];

type LlmConceptResult = {
  concept_class: ConceptClass;
  id_col: string;
  properties: Record<string, string>;
};

async function classifyTable(
  tableName: string,
  columns: string[],
): Promise<LlmConceptResult> {
  const prompt = `Given this database table:
Table name: ${tableName}
Columns: ${columns.join(', ')}

Classify this table as one of these concept types:
${CONCEPT_TAXONOMY.join(', ')}

Then identify:
- "concept_class": the best matching concept type
- "id_col": the primary identifier column (usually 'id' or '{tableName}_id')
- "properties": a map of semantic property names to column names (e.g. {"name": "full_name", "email": "email_address"})

Return only valid JSON matching:
{ "concept_class": string, "id_col": string, "properties": { [semanticName]: columnName } }`;

  try {
    const raw = await chatComplete(
      [{ role: 'user', content: prompt }],
      undefined,
      routeModel('semantic_inference'),
    );
    const { thinking, answer } = extractR1Response(raw);
    if (thinking) console.debug('[r1-thinking]', thinking);
    return JSON.parse(answer.trim()) as LlmConceptResult;
  } catch {
    return {
      concept_class: 'Other',
      id_col: 'id',
      properties: {},
    };
  }
}

export async function runConceptClassifier(
  metadata: DatasourceMetadata,
): Promise<Record<string, ConceptDefinition>> {
  const concepts: Record<string, ConceptDefinition> = {};

  const tableColumns = new Map<string, string[]>();
  const tableNames = new Map<number, string>();
  for (const t of metadata.tables ?? []) {
    tableNames.set(t.id, t.name);
    tableColumns.set(t.name, []);
  }
  for (const col of metadata.columns ?? []) {
    const table = tableNames.get(col.table_id);
    if (table) {
      tableColumns.get(table)?.push(col.name);
    }
  }

  for (const [tableName, columns] of tableColumns.entries()) {
    const result = await classifyTable(tableName, columns);
    if (result.concept_class === 'Other') continue;

    const conceptName =
      result.concept_class === 'Person'
        ? tableName.charAt(0).toUpperCase() + tableName.slice(1)
        : result.concept_class;

    concepts[conceptName] = {
      is_a: [result.concept_class],
      maps_to: `public.${tableName}`,
      id_col: result.id_col,
      properties: result.properties,
    };
  }

  return concepts;
}
