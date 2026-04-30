import fs from 'node:fs/promises';
import path from 'node:path';
import { chatComplete } from '../llm/chat.js';
import { routeModel, extractR1Response } from '../llm/model-router.js';
import type { ClassifiedError, QueryResult } from './error-classifier.js';
import type { ErrorFixStore } from '@qwery/vector-store';

type SemanticSummary = Record<string, { label?: string; sql?: string; table?: string }>;

type LabelMapEntry = { label: string; synonyms?: string[] };
type LabelMap = Record<string, LabelMapEntry>;

async function loadLabelMap(datasourceId: string): Promise<LabelMap> {
  const storageDir = process.env.QWERY_STORAGE_DIR ?? 'qwery.db';
  const labelMapPath = path.join(
    storageDir,
    'datasources',
    datasourceId,
    'label_map.json',
  );
  try {
    const raw = await fs.readFile(labelMapPath, 'utf-8');
    return JSON.parse(raw) as LabelMap;
  } catch {
    return {};
  }
}

function extractColumnFromEvidence(evidence: string): string | null {
  const patterns = [
    /no such column[:\s]+["'`]?(\w+)["'`]?/i,
    /column[s]?\s+["'`](\w+)["'`]/i,
    /["'`](\w+)["'`]\s+(?:does not exist|not found|is unknown)/i,
    /unknown column\s+["'`]?(\w+)["'`]?/i,
    /invalid column name\s+["'`]?(\w+)["'`]?/i,
  ];
  for (const re of patterns) {
    const m = evidence.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

export type SemanticLayerShape = {
  measures?: Record<string, { label?: string; sql?: string; table?: string }>;
  dimensions?: Record<string, { label?: string; sql?: string; table?: string }>;
  business_rules?: Record<
    string,
    { label?: string; sql?: string; table?: string; hidden?: boolean }
  >;
};

function summarizeSemanticLayer(layer: SemanticLayerShape): SemanticSummary {
  return Object.fromEntries(
    Object.entries({
      ...(layer.measures ?? {}),
      ...(layer.dimensions ?? {}),
      ...(layer.business_rules ?? {}),
    }).slice(0, 10),
  );
}

function safeJsonParse<T>(text: string, fallback: T): T {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return fallback;
  }
}

export async function classifyWithLLM(
  question: string,
  sql: string,
  result: QueryResult,
  semanticLayer: SemanticLayerShape,
): Promise<ClassifiedError> {
  const prompt = `You are a SQL error classifier for a NL2SQL system.

User question: "${question}"

Generated SQL:
${sql}

Execution result (first 5 rows or error):
${JSON.stringify(result.rows?.slice(0, 5) ?? result.error)}

Available semantic layer fields:
${JSON.stringify(summarizeSemanticLayer(semanticLayer))}

Classify the error into exactly ONE of these classes:
- schema_mismatch: wrong table or column name
- join_inconsistency: fan-out, missing join, wrong cardinality
- aggregation_misuse: wrong aggregate function or missing GROUP BY
- filter_error: missing required filter (soft-delete, status, etc.)
- value_mismatch: wrong enum value or case
- intent_drift: SQL is valid but does not answer the question
- execution_error: syntax or runtime error

Respond as JSON only:
{"errorClass":"...","confidence":"high|medium|low","evidence":"one sentence","suggestedFix":"one-line fix","clause":"SQL clause with the error or null","reason":"one sentence"}`;

  const raw = await chatComplete(prompt, routeModel('correction'));
  const { thinking, answer } = extractR1Response(raw);
  if (thinking) console.debug('[r1-thinking]', thinking);
  return safeJsonParse<ClassifiedError>(answer, {
    errorClass: 'execution_error',
    confidence: 'medium',
    evidence: 'Could not classify error',
    suggestedFix: 'Review SQL manually',
    clause: null,
    reason: null,
  });
}

export async function generateCorrectionPlan(
  question: string,
  sql: string,
  error: ClassifiedError,
  semanticLayer: SemanticLayerShape,
  cotPlan: string | null,
  datasourceId?: string,
  errorFixStore?: ErrorFixStore,
): Promise<{ editPlan: string; correctedSQL: string }> {
  // Fast deterministic path for schema_mismatch: check label_map.json synonyms
  // before paying for an LLM correction call.
  if (error.errorClass === 'schema_mismatch' && datasourceId) {
    try {
      const labelMap = await loadLabelMap(datasourceId);
      const failedColumn = extractColumnFromEvidence(error.evidence);
      if (failedColumn && Object.keys(labelMap).length > 0) {
        const match = Object.entries(labelMap).find(([, entry]) =>
          entry.synonyms?.some(
            (s) => s.toLowerCase() === failedColumn.toLowerCase(),
          ),
        );
        if (match) {
          const [correctRef] = match;
          return {
            editPlan: `Replace "${failedColumn}" with "${correctRef}" — exact column name from label_map`,
            correctedSQL: sql.replaceAll(failedColumn, correctRef),
          };
        }
      }
    } catch {
      /* fall through to LLM correction */
    }
  }

  // Inject few-shot examples from error-fix memory for this error class
  let fewShotSection = '';
  if (errorFixStore && datasourceId) {
    try {
      const examples = await errorFixStore.findSimilar(sql, datasourceId, error.errorClass, 2, 0.70);
      if (examples.length > 0) {
        fewShotSection = `\nPast fixes for similar "${error.errorClass}" errors:\n${examples
          .map((e) => `Failed SQL: ${e.failedSql}\nFix applied: ${e.editPlan}\nResult SQL: ${e.correctedSql}`)
          .join('\n---\n')}\n`;
        console.info(`[correction-planner] injecting ${examples.length} few-shot example(s) for ${error.errorClass}`);
      }
    } catch {
      /* non-blocking — proceed without examples */
    }
  }

  const clauseContext = error.clause
    ? `The error is in: ${error.clause}\nReason: ${error.reason ?? error.evidence}\nFix only that clause. Do not regenerate the entire query.`
    : `Evidence: ${error.evidence}\nSuggested fix: ${error.suggestedFix}`;

  const prompt = `You are a SQL correction agent.

Original question: "${question}"
${cotPlan ? `Query plan:\n${cotPlan}\n` : ''}
Failed SQL:
${sql}

Error class: ${error.errorClass}
${clauseContext}
${fewShotSection}
Relevant semantic layer fields:
${JSON.stringify(summarizeSemanticLayer(semanticLayer))}

Produce:
1. editPlan: numbered list of specific changes (e.g. "1. Add WHERE del_flag = 0.")
2. correctedSQL: the fixed SQL query

Respond as JSON only: {"editPlan":"...","correctedSQL":"..."}`;

  const raw = await chatComplete(prompt, routeModel('correction'));
  const { thinking, answer } = extractR1Response(raw);
  if (thinking) console.debug('[r1-thinking]', thinking);
  return safeJsonParse(answer, { editPlan: '', correctedSQL: sql });
}
