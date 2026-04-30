import { chatComplete } from '../llm/chat.js';
import { routeModel, extractR1Response } from '../llm/model-router.js';
import {
  classifyIntent,
  assignComplexity,
  extractTemporalContext,
  type QueryIntent,
  type QueryPlan,
  type SubQuery,
  type ValueLiteral,
} from './intent-classifier.js';

type FieldSummary = {
  label: string;
  sql: string;
  filters?: string[];
  description?: string;
  when_to_use?: string;
};

/** Extract typed literal values from a natural language question for sql-template placeholder filling. */
export function extractValueLiterals(question: string): ValueLiteral[] {
  const literals: ValueLiteral[] = [];

  // Quoted strings
  const quoted = question.matchAll(/["']([^"']{1,60})["']/g);
  for (const m of quoted) {
    if (m[1]) literals.push({ type: 'STRING', value: m[1] });
  }

  // Integers (not years — handled by temporal context)
  const integers = question.matchAll(/\b(?!(?:19|20)\d{2}\b)(\d{1,9})\b/g);
  for (const m of integers) {
    if (m[1] && !literals.some((l) => l.value === m[1])) {
      literals.push({ type: 'INTEGER', value: m[1] });
    }
  }

  // Floats
  const floats = question.matchAll(/\b(\d+\.\d+)\b/g);
  for (const m of floats) {
    if (m[1]) literals.push({ type: 'FLOAT', value: m[1] });
  }

  return literals.slice(0, 10);
}

function safeParseArray<T>(text: string, fallback: T[]): T[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]) as T[];
  } catch {
    return fallback;
  }
}

export async function decomposeQuery(
  question: string,
  intent: QueryIntent,
): Promise<SubQuery[]> {
  if (intent !== 'multi_hop') {
    return [{ id: 'q1', description: question, dependsOn: [] }];
  }

  const prompt = `Decompose this data question into independent sub-queries.

Question: "${question}"
Intent: ${intent}

Rules:
- Each sub-query must be independently executable against the database
- Use "dependsOn" only when one sub-query needs results from another
- Maximum 3 sub-queries
- For multi_hop: sub-query 1 = current period, sub-query 2 = comparison period, sub-query 3 = delta
- For comparison: sub-query 1 = metric for all entities, sub-query 2 = ranking/filter

Respond as JSON array only:
[{ "id": "q1", "description": "...", "dependsOn": [] }]`;

  const raw = await chatComplete(prompt, routeModel('reasoning'));
  const { thinking, answer } = extractR1Response(raw);
  if (thinking) console.debug('[r1-thinking]', thinking);
  return safeParseArray<SubQuery>(answer, [
    { id: 'q1', description: question, dependsOn: [] },
  ]);
}

export function generateCoTPlan(
  question: string,
  intent: QueryIntent,
  subQueries: SubQuery[],
  fields: FieldSummary[],
  tribalRules?: string[],
  tableSchemas?: Record<string, string[]>,
): string {
  const fieldList = fields
    .map((f) => {
      const parts = [
        `- ${f.label}: ${f.sql}${f.filters?.length ? ` WHERE ${f.filters.join(' AND ')}` : ''}`,
      ];
      if (f.when_to_use) parts.push(`  → when to use: ${f.when_to_use}`);
      if (f.description) parts.push(`  → description: ${f.description}`);
      return parts.join('\n');
    })
    .join('\n');

  const rulesSection =
    tribalRules && tribalRules.length > 0
      ? `\nKnown correction rules for this datasource:\n${tribalRules.map((r) => `- ${r}`).join('\n')}\n`
      : '';

  const tableSchemasSection =
    tableSchemas && Object.keys(tableSchemas).length > 0
      ? `\nAvailable columns (use ONLY these exact names — never invent column names):\n${Object.entries(tableSchemas)
          .map(([tbl, cols]) => `${tbl}: ${cols.join(', ')}`)
          .join('\n')}\n`
      : '';

  return `Query plan for: "${question}"
Intent: ${intent}
${rulesSection}${tableSchemasSection}Available fields:
${fieldList || '(none resolved yet)'}

Steps:
${subQueries
  .map(
    (sq, i) =>
      `${i + 1}. ${sq.description}${sq.dependsOn.length ? ` (uses results from: ${sq.dependsOn.join(', ')})` : ''}`,
  )
  .join('\n')}

SQL generation guidance:
- Use the field SQL expressions verbatim from the semantic layer
- Apply all listed filters — do not omit them
- For aggregations: GROUP BY all non-aggregated SELECT columns
- For multi-hop: map each subQuery to one runQuery call; respect dependsOn ordering
- Pass results from prerequisite sub-queries as literal values into dependent SQL`;
}

export async function buildQueryPlan(
  question: string,
  fields: FieldSummary[],
  tribalRules?: string[],
  tableSchemas?: Record<string, string[]>,
): Promise<QueryPlan> {
  const intent = classifyIntent(question);
  const complexity = assignComplexity(intent);
  const temporalContext = extractTemporalContext(question);

  const subQueries = await decomposeQuery(question, intent);
  const cotPlan = generateCoTPlan(question, intent, subQueries, fields, tribalRules, tableSchemas);
  const valueLiterals = extractValueLiterals(question);

  return {
    intent,
    complexity,
    subQueries,
    cotPlan,
    temporalContext,
    requiresMultiPath: complexity === 3,
    valueLiterals,
  };
}
