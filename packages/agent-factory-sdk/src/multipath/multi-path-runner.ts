import type { ResolvedField } from '../tools/get-semantic-context.js';
import type { QueryPlan } from '../planning/intent-classifier.js';
import type { QueryResult } from '../correction/error-classifier.js';
import {
  generatePath1,
  generatePath2,
  generatePath3,
  type JoinDef,
  type QueryTrace,
} from './sql-generator.js';
import {
  selectByConsistency,
  judgeSQL,
  type CandidateResult,
} from './consistency-selector.js';

type DriverLike = {
  query: (sql: string) => Promise<{ columns: Array<string | { name: string }>; rows: unknown[] }>;
};

type EpisodicMemoryLike = {
  findSimilar: (
    question: string,
    datasourceId: string,
    threshold: number,
  ) => Promise<QueryTrace | null>;
} | null;

function toQueryResult(
  raw: { columns: Array<string | { name: string }>; rows: unknown[] },
): QueryResult {
  return {
    columns: raw.columns.map((c) =>
      typeof c === 'string' ? c : (c as { name: string }).name,
    ),
    rows: raw.rows,
  };
}

async function execSQL(
  driver: DriverLike,
  sql: string,
  path: 1 | 2 | 3,
): Promise<CandidateResult> {
  try {
    const raw = await driver.query(sql);
    return { path, sql, result: toQueryResult(raw), error: null };
  } catch (err) {
    return {
      path,
      sql,
      result: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runMultiPath(
  question: string,
  agentSQL: string,
  queryPlan: QueryPlan,
  fields: ResolvedField[],
  joins: JoinDef[],
  businessRules: string[],
  driver: DriverLike,
  episodicMemory: EpisodicMemoryLike,
  datasourceId: string,
): Promise<{ sql: string; result: QueryResult; path: number }> {
  if (queryPlan.complexity === 1) {
    const raw = await driver.query(agentSQL);
    return { sql: agentSQL, result: toQueryResult(raw), path: 2 };
  }

  const similarTrace = episodicMemory
    ? await episodicMemory.findSimilar(question, datasourceId, 0.85).catch(() => null)
    : null;

  const [sql1, sql3] = await Promise.all([
    Promise.resolve(generatePath1(fields, joins, businessRules, queryPlan.intent)),
    generatePath3(question, similarTrace, fields),
  ]);

  const execTasks: Promise<CandidateResult>[] = [
    execSQL(driver, sql1, 1),
    // path 2: agent's own SQL, guided by CoT from getSemanticContext
    execSQL(driver, agentSQL, 2),
  ];
  if (sql3) execTasks.push(execSQL(driver, sql3, 3));

  const candidates = await Promise.all(execTasks);

  // Also regenerate path2 with dedicated SQL model + skeleton+fill for CoT adherence
  const cotPlan = queryPlan.cotPlan ?? '';
  if (cotPlan) {
    const sql2Routed = await generatePath2(question, cotPlan, fields, queryPlan.valueLiterals).catch(() => null);
    if (sql2Routed) {
      const routed = await execSQL(driver, sql2Routed, 2);
      if (!routed.error) candidates.push(routed);
    }
  }

  const winner =
    selectByConsistency(candidates) ??
    (await judgeSQL(question, candidates));

  return { sql: winner.sql, result: winner.result, path: winner.path };
}
