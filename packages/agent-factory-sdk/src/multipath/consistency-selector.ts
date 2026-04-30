import { chatComplete } from '../llm/chat.js';
import { routeModel } from '../llm/model-router.js';
import type { QueryResult } from '../correction/error-classifier.js';

export type CandidateResult = {
  path: 1 | 2 | 3;
  sql: string;
  result: QueryResult;
  error: string | null;
};

function fingerprint(c: CandidateResult): string {
  const rows = c.result.rows?.slice(0, 3) ?? [];
  return JSON.stringify({
    cols: c.result.columns,
    rowCount: c.result.rows?.length,
    sample: rows,
  });
}

export function selectByConsistency(
  candidates: CandidateResult[],
): CandidateResult | null {
  const valid = candidates.filter((c) => !c.error && c.result.rows);

  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0] ?? null;

  const prints = valid.map(fingerprint);

  for (let i = 0; i < prints.length; i++) {
    const agreeing = valid.filter((_, j) => prints[j] === prints[i]);
    if (agreeing.length >= 2) {
      return agreeing.sort((a, b) => a.path - b.path)[0] ?? null;
    }
  }

  return null;
}

function safeParseWinner(text: string, fallback: number): number {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    const obj = JSON.parse(match[0]) as { winner?: number };
    return typeof obj.winner === 'number' ? obj.winner : fallback;
  } catch {
    return fallback;
  }
}

export async function judgeSQL(
  question: string,
  candidates: CandidateResult[],
): Promise<CandidateResult> {
  const valid = candidates.filter((c) => !c.error);
  if (valid.length === 0) return candidates[0] ?? { path: 1, sql: '', result: {}, error: 'no candidates' };
  if (valid.length === 1) return valid[0] ?? candidates[0] ?? { path: 1, sql: '', result: {}, error: 'no candidates' };

  const prompt = `Select the best SQL query for this question.

Question: "${question}"

Candidates:
${valid
  .map(
    (c, i) => `--- Candidate ${i + 1} (path ${c.path}) ---
SQL:
${c.sql}
Result preview (first 3 rows):
${JSON.stringify(c.result.rows?.slice(0, 3))}
Row count: ${c.result.rows?.length ?? 0}`,
  )
  .join('\n\n')}

Which candidate best answers the question? Consider:
1. Does the result shape match what the question asks for?
2. Is the row count reasonable?
3. Are the column names meaningful?

Respond as JSON only: { "winner": 1 }  (1-indexed candidate number)`;

  const response = await chatComplete(prompt, routeModel('judging'));
  const winnerIdx = safeParseWinner(response, 1) - 1;
  const picked = valid[winnerIdx] ?? valid[0];
  return picked ?? { path: 1 as const, sql: '', result: {}, error: 'judge failed' };
}
