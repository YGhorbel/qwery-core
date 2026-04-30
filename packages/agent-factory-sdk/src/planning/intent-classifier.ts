import fs from 'node:fs/promises';
import path from 'node:path';

export type QueryIntent =
  | 'simple_lookup'
  | 'aggregation'
  | 'multi_hop'
  | 'comparison'
  | 'calculation'
  | 'conversational';

export type SubQuery = {
  id: string;
  description: string;
  dependsOn: string[];
};

export type ValueLiteral = {
  type: 'INTEGER' | 'FLOAT' | 'STRING';
  value: string;
};

export type QueryPlan = {
  intent: QueryIntent;
  complexity: 1 | 2 | 3;
  subQueries: SubQuery[];
  cotPlan: string;
  temporalContext: string | null;
  requiresMultiPath: boolean;
  valueLiterals: ValueLiteral[];
};

const DATA_KEYWORDS = [
  'show', 'what', 'how many', 'count', 'sum', 'average',
  'total', 'revenue', 'sales', 'orders', 'customers', 'profit',
  'list', 'find', 'give', 'get',
];

const MULTI_HOP_SIGNALS = [
  'vs last', 'compared to', 'versus', 'year over year', 'yoy',
  'month over month', 'mom', 'same period', 'growth', 'change',
  'difference between', 'vs previous',
];

const COMPARISON_SIGNALS = [
  'top', 'bottom', 'best', 'worst', 'ranking', 'rank', 'highest', 'lowest',
];

const CALC_SIGNALS = [
  'margin', 'ratio', 'rate', 'percentage', 'per', 'divided by', 'minus', 'subtract',
];

const AGG_SIGNALS = [
  'total', 'sum', 'count', 'average', 'avg', 'by', 'group', 'breakdown', 'per',
];

const TEMPORAL_PATTERN =
  /\b(last|this|next|previous|current|yesterday|today|tomorrow|week|month|quarter|year|q1|q2|q3|q4|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec|\d{4}|\d{1,2}\/\d{1,2})\b/gi;

export function classifyIntent(question: string): QueryIntent {
  const q = question.toLowerCase();
  if (!DATA_KEYWORDS.some((k) => q.includes(k))) return 'conversational';
  if (MULTI_HOP_SIGNALS.some((s) => q.includes(s))) return 'multi_hop';
  if (COMPARISON_SIGNALS.some((s) => q.includes(s))) return 'comparison';
  if (CALC_SIGNALS.some((s) => q.includes(s))) return 'calculation';
  if (AGG_SIGNALS.some((s) => q.includes(s))) return 'aggregation';
  return 'simple_lookup';
}

export function assignComplexity(intent: QueryIntent): 1 | 2 | 3 {
  const map: Record<QueryIntent, 1 | 2 | 3> = {
    conversational: 1,
    simple_lookup: 1,
    aggregation: 2,
    comparison: 2,
    calculation: 2,
    multi_hop: 3,
  };
  return map[intent];
}

export function extractTemporalContext(question: string): string | null {
  const matches = question.match(TEMPORAL_PATTERN);
  return matches ? [...new Set(matches.map((m) => m.toLowerCase()))].join(', ') : null;
}

type OntologyConceptShape = {
  concepts?: Record<string, { maps_to?: string; is_a?: string[] }>;
};

/**
 * Reads ontology.json for the given datasource and returns a map of
 * tableName → conceptClass (e.g. "drivers" → "Person").
 * Returns an empty map if the file does not exist yet.
 */
export async function loadOntologyConcepts(
  datasourceId: string,
): Promise<Map<string, string>> {
  const storageDir = process.env.QWERY_STORAGE_DIR ?? 'qwery.db';
  const ontologyPath = path.join(
    storageDir,
    'datasources',
    datasourceId,
    'ontology.json',
  );
  const map = new Map<string, string>();
  try {
    const raw = await fs.readFile(ontologyPath, 'utf-8');
    const ontology = JSON.parse(raw) as OntologyConceptShape;
    for (const [name, concept] of Object.entries(ontology.concepts ?? {})) {
      const tableName = concept.maps_to?.split('.').pop();
      if (tableName) {
        map.set(tableName, concept.is_a?.[0] ?? name);
      }
    }
  } catch {
    /* ontology not built yet — return empty map */
  }
  return map;
}
