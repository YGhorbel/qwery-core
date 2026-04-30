import { chatComplete } from '../llm/chat.js';
import { routeModel } from '../llm/model-router.js';
import type { ResolvedField } from '../tools/get-semantic-context.js';
import type { QueryIntent, ValueLiteral } from '../planning/intent-classifier.js';

export type JoinDef = {
  type: string;
  to: string;
  sql_on: string;
};

export type QueryTrace = {
  question: string;
  sql_final: string;
};

export function generatePath1(
  fields: ResolvedField[],
  joins: JoinDef[],
  businessRules: string[],
  intent: QueryIntent,
): string {
  const measures = fields.filter((f) => f.type === 'measure');
  const dimensions = fields.filter((f) => f.type === 'dimension');

  const selectFields =
    intent === 'simple_lookup'
      ? fields
      : measures.length > 0
        ? [...dimensions, ...measures]
        : fields;

  const select = selectFields
    .map((f) => `${f.sql} AS "${f.label}"`)
    .join(',\n  ');

  const groupByCols = dimensions.map((f) => f.sql);

  const fromTable = fields[0]?.table ?? 'unknown';
  const joinClauses = joins.map(
    (j) => `${j.type.toUpperCase()} JOIN ${j.to} ON ${j.sql_on}`,
  );

  const filters = [
    ...fields.flatMap((f) => f.filters ?? []),
    ...businessRules,
  ];

  return [
    `SELECT\n  ${select}`,
    `FROM ${fromTable}`,
    ...joinClauses,
    filters.length ? `WHERE ${filters.join('\n  AND ')}` : '',
    groupByCols.length ? `GROUP BY ${groupByCols.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Fill typed placeholders deterministically from the extracted value literals. */
export function fillPlaceholders(skeleton: string, valueLiterals: ValueLiteral[]): string {
  let result = skeleton;
  const byType: Record<string, string[]> = {};

  for (const lit of valueLiterals) {
    (byType[lit.type] ??= []).push(lit.value);
  }

  // Replace {INTEGER_N}, {STRING_N}, {FLOAT_N} with the Nth literal of that type
  result = result.replace(/\{(INTEGER|STRING|FLOAT)_(\d+)\}/g, (match, type, nStr) => {
    const n = parseInt(nStr, 10) - 1;
    const candidates = byType[type as string];
    if (candidates && candidates[n] !== undefined) {
      const val = candidates[n]!;
      return type === 'STRING' ? `'${val.replace(/'/g, "''")}'` : val;
    }
    return 'NULL';
  });

  return result;
}

export async function generatePath2(
  question: string,
  cotPlan: string,
  fields: ResolvedField[],
  valueLiterals?: ValueLiteral[],
): Promise<string> {
  // If there are literal values in the question, use skeleton+fill to prevent value hallucination
  if (valueLiterals && valueLiterals.length > 0) {
    const skeletonPrompt = `Generate SQL following this exact plan. Use typed placeholders {INTEGER_1}, {STRING_1}, {FLOAT_1} etc. instead of hardcoding literal values from the question. The placeholders will be filled deterministically.

Question: "${question}"

Step-by-step plan:
${cotPlan}

Use ONLY these field expressions (verbatim):
${fields.map((f) => `${f.label}: ${f.sql}${f.filters?.length ? ` [filters: ${f.filters.join(', ')}]` : ''}`).join('\n')}

Rules:
- Replace all literal numbers and strings from the question with {TYPE_N} placeholders
- Example: WHERE year = 2007 → WHERE year = {INTEGER_1}
- Example: WHERE nationality = 'British' → WHERE nationality = {STRING_1}
- Do NOT use placeholders for SQL keywords, column names, or aggregate functions

Generate the SQL skeleton only. No explanation. No markdown.`;

    const skeleton = await chatComplete(skeletonPrompt, routeModel('sql_generation'));
    return fillPlaceholders(skeleton.trim(), valueLiterals);
  }

  // Pure aggregation queries with no value literals — direct generation
  const prompt = `Generate SQL following this exact plan.

Question: "${question}"

Step-by-step plan:
${cotPlan}

Use ONLY these field expressions (verbatim):
${fields.map((f) => `${f.label}: ${f.sql}${f.filters?.length ? ` [filters: ${f.filters.join(', ')}]` : ''}`).join('\n')}

Generate the SQL query only. No explanation. No markdown.`;

  return chatComplete(prompt, routeModel('sql_generation'));
}

export async function generatePath3(
  question: string,
  similarTrace: QueryTrace | null,
  fields: ResolvedField[],
): Promise<string | null> {
  if (!similarTrace) return null;

  const prompt = `Adapt this past SQL query to answer the new question.

Past question: "${similarTrace.question}"
Past SQL:
${similarTrace.sql_final}

New question: "${question}"
Available fields (use these expressions, not the past query's columns):
${fields.map((f) => `${f.label}: ${f.sql}`).join('\n')}

Generate adapted SQL only. No explanation. No markdown.`;

  return chatComplete(prompt, routeModel('sql_template'));
}
