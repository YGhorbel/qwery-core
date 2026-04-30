import { chatComplete } from '../llm/chat.js';
import { routeModel, extractR1Response } from '../llm/model-router.js';
import type { ClassifiedError, QueryResult } from '../correction/error-classifier.js';
import type { QueryPlan } from '../planning/intent-classifier.js';

export type VerificationResult =
  | { pass: true }
  | {
      pass: false;
      errorClass: ClassifiedError['errorClass'];
      evidence: string;
      suggestedFix: string;
      confidence: number;
    };

// ─── Stage 1: Heuristic checks (zero LLM cost) ───────────────────────────────

/**
 * Deterministic regex-based checks against the CoT plan + SQL + result shape.
 * Catches the most common semantic errors without any LLM call.
 */
export function heuristicVerify(
  plan: QueryPlan,
  result: QueryResult,
  sql: string,
): VerificationResult {
  const sqlLower = sql.toLowerCase();
  const cotLower = (plan.cotPlan ?? '').toLowerCase();
  const rows = result.rows ?? [];
  const rowCount = rows.length;

  // Skip all heuristics for simple diagnostic/exploration queries —
  // these never need GROUP BY and their cotPlan often contains grouping words
  const isDiagnostic =
    /^\s*SELECT\s+\*\s+FROM\s+\w+(\s+LIMIT\s+\d+)?\s*;?\s*$/i.test(sql) ||
    /^\s*SELECT\s+DISTINCT\s+\w+\s+FROM\s+\w+\s*;?\s*$/i.test(sql) ||
    /^\s*SELECT\s+COUNT\s*\(\s*\*\s*\)\s*(AS\s+\w+\s*)?FROM\s+\w+\s*;?\s*$/i.test(sql);
  if (isDiagnostic) return { pass: true };

  // ── function_error: aggregation direction mismatch ──────────────────────
  // Plan says "minimum/lowest/worst" but SQL uses MAX
  const wantsMin =
    /\b(minimum|lowest|least|worst|smallest|fewest|bottom|earliest|first|slowest)\b/.test(
      cotLower,
    );
  const wantsMax =
    /\b(maximum|highest|most|best|largest|greatest|top|latest|last|fastest)\b/.test(cotLower);

  if (wantsMin && /\bmax\s*\(/.test(sqlLower)) {
    return {
      pass: false,
      errorClass: 'intent_drift',
      evidence: 'Plan requests minimum/lowest/slowest but SQL uses MAX()',
      suggestedFix: 'Replace MAX() with MIN() to match the intent of finding the lowest value',
      confidence: 0.95,
    };
  }
  if (wantsMax && /\bmin\s*\(/.test(sqlLower)) {
    return {
      pass: false,
      errorClass: 'intent_drift',
      evidence: 'Plan requests maximum/highest/fastest but SQL uses MIN()',
      suggestedFix: 'Replace MIN() with MAX() to match the intent of finding the highest value',
      confidence: 0.95,
    };
  }

  // Sorting direction: "slowest lap" → ORDER BY time ASC (ascending = slowest first)
  // but LLM often generates ORDER BY time DESC
  if (wantsMin && /order\s+by\s+[\w.]+\s+desc/i.test(sql) && /\blimit\s+1\b/i.test(sql)) {
    return {
      pass: false,
      errorClass: 'intent_drift',
      evidence:
        'Plan wants minimum/slowest but SQL orders DESC LIMIT 1 (which gives maximum)',
      suggestedFix: 'Change ORDER BY ... DESC to ORDER BY ... ASC to get the minimum value',
      confidence: 0.92,
    };
  }
  if (wantsMax && /order\s+by\s+[\w.]+\s+asc/i.test(sql) && /\blimit\s+1\b/i.test(sql)) {
    return {
      pass: false,
      errorClass: 'intent_drift',
      evidence:
        'Plan wants maximum/fastest but SQL orders ASC LIMIT 1 (which gives minimum)',
      suggestedFix: 'Change ORDER BY ... ASC to ORDER BY ... DESC to get the maximum value',
      confidence: 0.92,
    };
  }

  // ── operator_error: comparison direction mismatch ─────────────────────
  const wantsGreater =
    /\b(more than|above|greater than|at least|over|exceed|higher than)\b/.test(cotLower);
  const wantsLess =
    /\b(less than|below|fewer than|under|at most|no more than|lower than)\b/.test(cotLower);

  if (wantsGreater && /where\s+[\w.]+\s*<[^=]/i.test(sql)) {
    return {
      pass: false,
      errorClass: 'intent_drift',
      evidence:
        'Plan uses "more than / above / greater than" language but SQL WHERE uses < operator',
      suggestedFix: 'Change < to > in the WHERE condition to match the directional intent',
      confidence: 0.88,
    };
  }
  if (wantsLess && /where\s+[\w.]+\s*>[^=]/i.test(sql)) {
    return {
      pass: false,
      errorClass: 'intent_drift',
      evidence:
        'Plan uses "less than / below / fewer than" language but SQL WHERE uses > operator',
      suggestedFix: 'Change > to < in the WHERE condition to match the directional intent',
      confidence: 0.88,
    };
  }

  // ── clause_error: missing GROUP BY when plan groups by something ──────
  const expectsGrouping =
    /\b(by\s+\w+|per\s+\w+|for each|grouped by|breakdown|each\s+\w+|group\s+by)\b/.test(
      cotLower,
    );
  const hasGroupBy = /\bgroup\s+by\b/i.test(sql);
  const hasAggregation = /\b(sum|count|avg|average|max|min)\s*\(/i.test(sql);
  if (expectsGrouping && !hasGroupBy && hasAggregation && plan.intent !== 'simple_lookup') {
    return {
      pass: false,
      errorClass: 'aggregation_misuse',
      evidence: 'Plan groups results by an entity but SQL has no GROUP BY clause',
      suggestedFix:
        'Add GROUP BY clause for the entity dimension mentioned in the plan',
      confidence: 0.82,
    };
  }

  // ── clause_error: missing DISTINCT when plan asks for unique values ───
  const wantsDistinct =
    /\b(unique|distinct|different|each unique|how many .{0,20} types)\b/.test(cotLower);
  const hasDistinct = /\bselect\s+distinct\b/i.test(sql);
  if (wantsDistinct && !hasDistinct && /\bcount\s*\(/i.test(sql)) {
    return {
      pass: false,
      errorClass: 'aggregation_misuse',
      evidence: 'Plan asks for unique/distinct count but SQL uses COUNT without DISTINCT',
      suggestedFix: 'Change COUNT(column) to COUNT(DISTINCT column)',
      confidence: 0.85,
    };
  }

  // ── scope_error: list question returned a single aggregated row ───────
  const expectsMany =
    /\b(list all|show all|which (drivers|teams|races|circuits|constructors)|all (drivers|teams|races)|every\s+\w+)\b/.test(
      cotLower,
    );
  if (
    expectsMany &&
    rowCount === 1 &&
    !/\b(count|sum|max|min|avg|average)\s*\(/i.test(sql)
  ) {
    return {
      pass: false,
      errorClass: 'intent_drift',
      evidence: `Plan expects a list of multiple results but SQL returned only 1 row`,
      suggestedFix:
        'Remove LIMIT 1 or any inadvertent aggregation that collapses the result set',
      confidence: 0.78,
    };
  }

  // ── scope_error: singular question returned too many unordered rows ───
  const questionStart = cotLower.slice(0, 80);
  const expectsOne =
    /^(who is|what is|what was|which is|find the|the (driver|team|race|circuit|winner))/.test(
      questionStart,
    );
  if (expectsOne && rowCount > 20 && !/order\s+by/i.test(sql)) {
    return {
      pass: false,
      errorClass: 'intent_drift',
      evidence: `Plan expects a single answer but SQL returned ${rowCount} rows without ordering`,
      suggestedFix:
        'Add ORDER BY + LIMIT 1, or add a more specific WHERE condition',
      confidence: 0.75,
    };
  }

  // ── value_error: value literal in question not present in SQL WHERE ───
  if (plan.valueLiterals && plan.valueLiterals.length > 0) {
    for (const literal of plan.valueLiterals) {
      if (literal.type === 'INTEGER' && literal.value.length >= 4) {
        // Only check year-like integers (4 digits) — high signal
        if (!sql.includes(literal.value)) {
          return {
            pass: false,
            errorClass: 'filter_error',
            evidence: `Question references the value ${literal.value} but SQL does not contain it`,
            suggestedFix: `Add WHERE condition with ${literal.value} to scope the result correctly`,
            confidence: 0.8,
          };
        }
      }
    }
  }

  return { pass: true };
}

// ─── Stage 2: LLM semantic check (complex queries only) ──────────────────────

function safeJsonParse<T>(text: string, fallback: T): T {
  const clean = text.replace(/```json|```/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return fallback;
  }
}

export async function llmVerify(params: {
  question: string;
  cotPlan: string;
  sql: string;
  resultSample: string;
}): Promise<VerificationResult> {
  const { question, cotPlan, sql, resultSample } = params;

  const prompt = `You are a semantic SQL auditor. Verify whether a SQL result faithfully answers the user's original question.

Original question:
"${question}"

Query plan (what the SQL was supposed to do):
${cotPlan}

Generated SQL:
${sql}

Result sample (columns + first 3 rows, total row count included):
${resultSample}

Does the SQL result faithfully answer the original question?

Check specifically for:
1. Wrong aggregate function (MAX instead of MIN or vice versa)
2. Wrong sort direction for top/bottom queries (ASC vs DESC)
3. Missing or wrong WHERE condition that changes scope
4. Wrong column selected (using gross_sales instead of net_sales etc.)
5. Missing GROUP BY when question asks for breakdown by category
6. Wrong comparison operator (> instead of <)
7. Result scope wrong (too many or too few rows for the question type)

Respond ONLY as JSON. No preamble, no explanation outside the JSON:
{"pass":true|false,"errorClass":"intent_drift"|"filter_error"|"aggregation_misuse"|null,"evidence":"one specific sentence"|null,"suggestedFix":"one actionable fix instruction"|null,"confidence":0.0}`;

  try {
    const raw = await chatComplete(prompt, routeModel('correction'));
    const { thinking, answer } = extractR1Response(raw);
    if (thinking) console.debug('[intent-verifier][r1-thinking]', thinking);

    const parsed = safeJsonParse<{
      pass: boolean;
      errorClass?: string;
      evidence?: string;
      suggestedFix?: string;
      confidence?: number;
    }>(answer, { pass: true });

    if (parsed.pass) return { pass: true };

    return {
      pass: false,
      errorClass: (parsed.errorClass ?? 'intent_drift') as ClassifiedError['errorClass'],
      evidence: parsed.evidence ?? 'LLM detected semantic mismatch',
      suggestedFix:
        parsed.suggestedFix ?? 'Re-examine the query logic against the question',
      confidence: parsed.confidence ?? 0.7,
    };
  } catch {
    console.warn('[intent-verifier] LLM verify failed — passing through');
    return { pass: true };
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Two-stage semantic faithfulness check.
 *
 * Stage 1 (always): free regex heuristics — catches MAX/MIN swaps,
 *   direction flips, missing GROUP BY / DISTINCT, scope errors.
 * Stage 2 (complex queries only): one cheap LLM call for deep semantic
 *   alignment checks that heuristics can't catch.
 *
 * Never throws. Returns { pass: true } on any internal failure.
 */
export async function verifyIntent(params: {
  question: string;
  plan: QueryPlan;
  sql: string;
  result: QueryResult;
  runLLMCheck?: boolean;
}): Promise<VerificationResult> {
  const { question, plan, sql, result, runLLMCheck } = params;

  // Stage 1: deterministic heuristics — zero LLM cost, always runs
  const heuristic = heuristicVerify(plan, result, sql);
  if (!heuristic.pass) {
    console.log(
      `[intent-verifier] Heuristic caught: ${heuristic.evidence} (confidence: ${(heuristic.confidence * 100).toFixed(0)}%)`,
    );
    return heuristic;
  }

  // Stage 2: LLM check — only for aggregation/comparison/multi-hop queries
  const shouldRunLLM = runLLMCheck ?? plan.complexity >= 2;
  if (!shouldRunLLM) return { pass: true };

  const rows = result.rows ?? [];
  const sample = JSON.stringify(
    {
      columns: result.columns ?? [],
      rows: rows.slice(0, 3),
      total_rows: rows.length,
    },
    null,
    2,
  );

  return llmVerify({
    question,
    cotPlan: plan.cotPlan ?? plan.intent,
    sql,
    resultSample: sample,
  });
}
