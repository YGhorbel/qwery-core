import { chatComplete } from '../llm/chat.js';
import { routeModel } from '../llm/model-router.js';
import type { ToolContext } from '../tools/tool.js';

export type ErrorClass =
  | 'schema_mismatch'
  | 'join_inconsistency'
  | 'aggregation_misuse'
  | 'filter_error'
  | 'value_mismatch'
  | 'intent_drift'
  | 'sort_error'
  | 'execution_error'
  | 'none'
  | 'unknown';

export type ClassifiedError = {
  errorClass: ErrorClass;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  suggestedFix: string;
  clause?: string | null;
  reason?: string | null;
};

export type CorrectionTrace = {
  classified: ClassifiedError;
  editPlan: string;
  correctedSQL: string;
  success: boolean;
};

export type QueryResult = {
  columns?: string[];
  rows?: unknown[];
  error?: string;
  hint?: string;
};

export type MinimalSemanticLayer = {
  business_rules?: Record<
    string,
    { hidden?: boolean; table?: string; sql?: string; label?: string }
  >;
};

export type SemanticField = {
  label?: string;
  sql?: string;
  filters?: string[];
};

export function extractTablesFromSQL(sql: string): string[] {
  const matches =
    sql.match(/\b(?:FROM|JOIN)\s+["'`]?(\w+)["'`]?/gi) ?? [];
  return [
    ...new Set(
      matches
        .map((m) =>
          m
            .replace(/\b(?:FROM|JOIN)\s+/i, '')
            .replace(/["'`]/g, '')
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ];
}

export function heuristicClassify(
  sql: string,
  result: QueryResult,
  semanticLayer: MinimalSemanticLayer,
): ClassifiedError | null {
  if (result.error) {
    return {
      errorClass: 'execution_error',
      confidence: 'high',
      evidence: result.error,
      suggestedFix: 'Fix SQL syntax or column reference',
      clause: null,
      reason: result.error,
    };
  }

  const tablesUsed = extractTablesFromSQL(sql);

  for (const table of tablesUsed) {
    const hiddenRules = Object.values(
      semanticLayer.business_rules ?? {},
    ).filter((r) => r.hidden === true && r.table?.toLowerCase() === table);

    for (const rule of hiddenRules) {
      const firstWord = rule.sql?.split(' ')[0]?.toLowerCase() ?? '';
      if (firstWord && !sql.toLowerCase().includes(firstWord)) {
        return {
          errorClass: 'filter_error',
          confidence: 'high',
          evidence: `Hidden rule "${rule.label ?? rule.sql}" not applied to table ${table}`,
          suggestedFix: `Add WHERE ${rule.sql}`,
          clause: 'WHERE clause',
          reason: `Hidden business rule for table ${table} not applied`,
        };
      }
    }
  }

  if (result.rows && result.rows.length > 10000 && /\bJOIN\b/i.test(sql)) {
    return {
      errorClass: 'join_inconsistency',
      confidence: 'medium',
      evidence: `Result has ${result.rows.length} rows — possible fan-out from join`,
      suggestedFix:
        'Check join cardinality, consider DISTINCT or many-to-one constraint',
      clause: 'JOIN clause',
      reason: 'Unexpectedly large row count suggests a many-to-many fan-out',
    };
  }

  return null;
}

export function isResultSuspect(result: QueryResult): boolean {
  if (!result.rows) return false;
  const rows = result.rows;

  if (rows.length === 1) {
    const row = rows[0];
    const vals = Array.isArray(row)
      ? (row as unknown[])
      : row && typeof row === 'object'
        ? Object.values(row as Record<string, unknown>)
        : [];
    if (vals.length === 1 && typeof vals[0] === 'number') {
      const v = vals[0] as number;
      if (v > 1_000_000_000) return true;
      if (v === 1000 || v === 10_000 || v === 100_000 || v === 1_000_000) return true;
    }
  }

  // All values in the first column are null — query returned no meaningful data
  if (rows.length > 0) {
    const firstColVals = rows.map((row) => {
      if (Array.isArray(row)) return (row as unknown[])[0];
      if (row && typeof row === 'object')
        return Object.values(row as Record<string, unknown>)[0];
      return undefined;
    });
    if (firstColVals.every((v) => v === null || v === undefined)) return true;
  }

  return false;
}

const VALID_ERROR_CLASSES: ErrorClass[] = [
  'schema_mismatch',
  'join_inconsistency',
  'aggregation_misuse',
  'filter_error',
  'value_mismatch',
  'intent_drift',
  'sort_error',
  'execution_error',
];

function parseClassifyResponse(raw: string): ClassifiedError {
  const errorClassMatch = raw.match(/ERROR_CLASS:\s*(\S+)/i);
  const confidenceMatch = raw.match(/CONFIDENCE:\s*(\S+)/i);
  const clauseMatch = raw.match(/CLAUSE:\s*(.+)/i);
  const reasonMatch = raw.match(/REASON:\s*(.+)/i);

  const rawClass = (errorClassMatch?.[1] ?? '').toLowerCase().trim();
  const rawConf = (confidenceMatch?.[1] ?? 'low').toLowerCase().trim();
  const clause = clauseMatch?.[1]?.trim() ?? null;
  const reason = reasonMatch?.[1]?.trim() ?? null;

  if (rawClass === 'correct') {
    return {
      errorClass: 'none',
      confidence: 'high',
      evidence: 'SQL correctly answers the question',
      suggestedFix: '',
      clause: null,
      reason: null,
    };
  }

  const errorClass: ErrorClass = VALID_ERROR_CLASSES.includes(
    rawClass as ErrorClass,
  )
    ? (rawClass as ErrorClass)
    : 'unknown';

  const confidence: 'high' | 'medium' | 'low' =
    rawConf === 'high' ? 'high' : rawConf === 'medium' ? 'medium' : 'low';

  return {
    errorClass,
    confidence,
    evidence: reason ?? `Classified as ${errorClass}`,
    suggestedFix: clause ? `Fix the ${clause}` : `Review ${errorClass} error`,
    clause,
    reason,
  };
}

async function llmClassify(
  question: string,
  sql: string,
  result: QueryResult,
  cotPlan: string | null,
  fieldsUsed: SemanticField[],
): Promise<ClassifiedError> {
  const rows = result.rows ?? [];
  const resultMeta = {
    columns: result.columns ?? [],
    row_count: rows.length,
    sample: rows.slice(0, 3),
  };

  const fieldSummary = fieldsUsed
    .slice(0, 8)
    .map(
      (f) =>
        `- ${f.label ?? '?'}: sql="${f.sql ?? ''}", filters=${JSON.stringify(f.filters ?? [])}`,
    )
    .join('\n');

  const prompt = `/no_think
You are a SQL semantic error classifier for a NL2SQL pipeline.

User question: "${question}"
${cotPlan ? `\nQuery plan (expected behavior):\n${cotPlan}\n` : ''}
Executed SQL:
${sql}

Result metadata:
${JSON.stringify(resultMeta, null, 2)}

Relevant field definitions:
${fieldSummary || '(none provided)'}

Error taxonomy (pick exactly one):
1. schema_mismatch     — wrong table or column name used
2. join_inconsistency  — wrong join condition, missing join, or fan-out
3. aggregation_misuse  — wrong aggregate function, missing GROUP BY, or wrong HAVING
4. filter_error        — missing or wrong WHERE condition (soft-delete, status filter, business rule)
5. value_mismatch      — wrong literal value, wrong enum, wrong date format
6. intent_drift        — SQL is syntactically valid but does not answer the question
7. sort_error          — wrong ORDER BY direction or missing LIMIT on a top-N question

If the SQL correctly answers the question, say CORRECT.

Respond in this exact format (no other text):
ERROR_CLASS: <class name or CORRECT>
CONFIDENCE: <high|medium|low>
CLAUSE: <the specific clause with the error, e.g. "WHERE clause" or "ORDER BY clause">
REASON: <one sentence explaining the error>`;

  try {
    const raw = await chatComplete(prompt, routeModel('correction'));
    return parseClassifyResponse(raw);
  } catch {
    return {
      errorClass: 'unknown',
      confidence: 'low',
      evidence: 'LLM classifier failed',
      suggestedFix: 'Review SQL manually',
      clause: null,
      reason: null,
    };
  }
}

export type ClassifyInput = {
  question: string;
  sql: string;
  result: QueryResult;
  semanticLayer: MinimalSemanticLayer;
  cotPlan?: string | null;
  fieldsUsed?: SemanticField[];
};

export async function classify(input: ClassifyInput): Promise<ClassifiedError> {
  const {
    question,
    sql,
    result,
    semanticLayer,
    cotPlan = null,
    fieldsUsed = [],
  } = input;

  // Stage 1: free heuristic — catches execution errors and hidden-rule violations
  const heuristic = heuristicClassify(sql, result, semanticLayer);
  if (heuristic !== null) {
    return heuristic;
  }

  // Stage 2: LLM check — only when result shape looks suspect
  if (isResultSuspect(result)) {
    return llmClassify(question, sql, result, cotPlan, fieldsUsed);
  }

  // Stage 3: no signal — treat as clean query
  return {
    errorClass: 'none',
    confidence: 'high',
    evidence: 'No errors detected',
    suggestedFix: '',
    clause: null,
    reason: null,
  };
}

export function storeCorrectionTrace(
  ctx: ToolContext,
  trace: CorrectionTrace,
): void {
  if (ctx.extra) {
    (ctx.extra as Record<string, unknown>).lastCorrectionTrace = trace;
  }
}
