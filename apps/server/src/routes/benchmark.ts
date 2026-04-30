import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  prompt,
  validateUIMessages,
  getDefaultModel,
} from '@qwery/agent-factory-sdk';
import { CreateConversationService } from '@qwery/domain/services';
import {
  ExtensionsRegistry,
  type DatasourceExtension,
} from '@qwery/extensions-sdk';
import { getDriverInstance } from '@qwery/extensions-loader';
import type { Repositories } from '@qwery/domain/repositories';
import { getTelemetry } from '../lib/telemetry';
import { handleDomainException } from '../lib/http-utils';

// ─── Zod schemas ────────────────────────────────────────────────────────────

const questionSchema = z.object({
  question_id: z.number(),
  db_id: z.string(),
  question: z.string(),
  evidence: z.string().optional().default(''),
  SQL: z.string(),
  difficulty: z.string().optional().default('unknown'),
  gold_rows: z.array(z.record(z.string(), z.unknown())).optional(),
  gold_duration_ms: z.number().optional(),
});

const runBodySchema = z.object({
  questions: z.array(questionSchema),
  datasource_map: z.record(z.string(), z.string()).optional().default({}),
  workers: z.number().int().min(1).max(20).optional().default(5),
  metrics: z
    .array(z.enum(['ex', 'f1']))
    .optional()
    .default(['ex', 'f1']),
  model: z.string().optional(),
});

const queryBodySchema = z.object({
  datasourceId: z.string().uuid(),
  sql: z.string().min(1),
});

// ─── Types ───────────────────────────────────────────────────────────────────

type BenchmarkQuestion = z.infer<typeof questionSchema>;

type QuestionResult = {
  question_id: number;
  db_id: string;
  datasource_id: string;
  difficulty: string;
  question: string;
  gold_sql: string;
  predicted_sql: string | null;
  status: string;
  correct: boolean;
  ex_strict: boolean;
  ex_subset: boolean;
  ex_superset: boolean;
  f1_score: number | null;
  r_ves: number | null;
  gold_rows: Record<string, unknown>[] | null;
  gold_duration_ms: number | null;
  pred_duration_ms: number | null;
  duration_ms: number;
  error: string | null;
  conversation_slug: string | null;
};

// ─── UUID detection ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveDatasourceId(
  dbId: string,
  datasourceMap: Record<string, string>,
): string | null {
  if (UUID_RE.test(dbId)) return dbId;
  return datasourceMap[dbId] ?? null;
}

// ─── SQL execution ───────────────────────────────────────────────────────────

async function executeSqlWithTiming(
  datasourceId: string,
  sql: string,
  repos: Repositories,
): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
  const datasource = await repos.datasource.findById(datasourceId);
  if (!datasource) throw new Error(`Datasource ${datasourceId} not found`);

  const extension = ExtensionsRegistry.get(datasource.datasource_provider) as
    | DatasourceExtension
    | undefined;
  if (!extension?.drivers?.length)
    throw new Error(
      `No driver for provider: ${datasource.datasource_provider}`,
    );

  const driver =
    extension.drivers.find((d) => d.runtime === 'node') ?? extension.drivers[0];
  if (!driver || driver.runtime !== 'node')
    throw new Error(
      `No node driver for provider: ${datasource.datasource_provider}`,
    );

  const instance = await getDriverInstance(driver, {
    config: datasource.config,
  });
  const t0 = Date.now();
  try {
    const result = await instance.query(sql.trim());
    return {
      rows: result.rows as Record<string, unknown>[],
      durationMs: Date.now() - t0,
    };
  } finally {
    await instance.close?.();
  }
}

// ─── Stream parsing ──────────────────────────────────────────────────────────

// The prompt() in-process stream uses Vercel AI SDK format:
//   data: <JSON>  — AI SDK events (tool-input-available, etc.)
//   a: <JSON>     — tool result lines (actual executed SQL)
// We mirror the same detection logic as wrapBenchmarkEarlyExit in agent-session.ts.
async function extractSqlFromStream(
  body: ReadableStream<Uint8Array>,
): Promise<string | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let lastInputSql: string | null = null;
  let lastResultSql: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let from = 0;
      let nl: number;
      while ((nl = buf.indexOf('\n', from)) !== -1) {
        const line = buf.slice(from, nl).trim();
        from = nl + 1;

        // Tool result line — actual executed SQL
        if (line.startsWith('a:')) {
          try {
            const parsed = JSON.parse(line.slice(2)) as { result?: unknown };
            const r = parsed.result as Record<string, unknown> | undefined;
            if (r) {
              if (typeof r.sqlQuery === 'string' && r.sqlQuery) {
                lastResultSql = r.sqlQuery;
              } else if (Array.isArray(r.results) && r.results.length > 0) {
                const first = r.results[0] as Record<string, unknown>;
                if (typeof first?.sqlQuery === 'string') {
                  lastResultSql = first.sqlQuery;
                }
              }
            }
          } catch {
            /* not a valid tool result */
          }
        }

        // tool-input-available — intended SQL before execution (fallback)
        if (line.startsWith('data:') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(5)) as {
              type?: string;
              toolName?: string;
              input?: Record<string, unknown>;
            };
            if (data.type === 'tool-input-available') {
              if (
                data.toolName === 'runQuery' &&
                typeof data.input?.query === 'string'
              ) {
                lastInputSql = data.input.query;
              } else if (
                data.toolName === 'runQueries' &&
                Array.isArray(data.input?.queries)
              ) {
                const first = (
                  data.input.queries as Record<string, unknown>[]
                )[0];
                if (typeof first?.query === 'string')
                  lastInputSql = first.query;
              }
            }
          } catch {
            /* not JSON */
          }
        }
      }
      buf = buf.slice(from);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore release errors */
    }
  }

  return lastResultSql ?? lastInputSql;
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

function normalizeValue(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? '1' : '0';
  if (typeof val === 'number') {
    const s = (Math.round(val * 1e4) / 1e4).toString().replace(/\.?0+$/, '');
    return s || '0';
  }
  const s = String(val).trim();
  if (s.toUpperCase() === 'NULL') return 'NULL';
  const n = parseFloat(s);
  if (!isNaN(n))
    return (Math.round(n * 1e4) / 1e4).toString().replace(/\.?0+$/, '') || '0';
  return s;
}

function normalizeRows(rows: Record<string, unknown>[]): Set<string> {
  return new Set(
    rows.map((r) => Object.values(r).map(normalizeValue).join('\x00')),
  );
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function computeEX(
  gold: Record<string, unknown>[],
  pred: Record<string, unknown>[],
) {
  const g = normalizeRows(gold);
  const p = normalizeRows(pred);
  return {
    strict: setsEqual(g, p),
    subset: [...g].every((v) => p.has(v)),
    superset: [...p].every((v) => g.has(v)),
  };
}

function computeF1(
  gold: Record<string, unknown>[],
  pred: Record<string, unknown>[],
): number {
  if (gold.length === 0 && pred.length === 0) return 1.0;
  if (gold.length === 0 || pred.length === 0) return 0.0;

  const goldTuples = gold.map((r) => Object.values(r).map(normalizeValue));
  const predTuples = pred.map((r) => Object.values(r).map(normalizeValue));

  let totalF1 = 0;
  for (const gt of goldTuples) {
    let bestF1 = 0;
    for (const pt of predTuples) {
      const n = Math.min(gt.length, pt.length);
      let matches = 0;
      for (let i = 0; i < n; i++) if (gt[i] === pt[i]) matches++;
      const prec = pt.length > 0 ? matches / pt.length : 0;
      const rec = gt.length > 0 ? matches / gt.length : 0;
      const f1 = prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0;
      bestF1 = Math.max(bestF1, f1);
    }
    totalF1 += bestF1;
  }
  return goldTuples.length > 0 ? totalF1 / goldTuples.length : 0;
}

// ─── Conversation management ─────────────────────────────────────────────────

// Reuse TUI constants used across the server
const TUI_TASK_ID = '550e8400-e29b-41d4-a716-446655440001';
const TUI_USER_ID = '550e8400-e29b-41d4-a716-446655440099';

let _defaultProjectId: string | undefined;

async function getDefaultProjectId(repos: Repositories): Promise<string> {
  if (_defaultProjectId) return _defaultProjectId;
  const projects = await repos.project.findAll();
  if (!projects.length)
    throw new Error('No project found — run POST /api/init first');
  _defaultProjectId = projects[0]!.id;
  return _defaultProjectId;
}

async function createBenchmarkConversation(
  datasourceId: string,
  repos: Repositories,
): Promise<string> {
  const projectId = await getDefaultProjectId(repos);
  const svc = new CreateConversationService(repos.conversation);
  const conv = await svc.execute({
    title: 'Benchmark',
    seedMessage: '',
    projectId,
    taskId: TUI_TASK_ID,
    datasources: [datasourceId],
    createdBy: TUI_USER_ID,
  });
  return conv.slug;
}

// ─── Concurrency pool ────────────────────────────────────────────────────────

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  onResult: (result: T) => void,
): Promise<void> {
  const queue = [...tasks];
  let queueIdx = 0;

  async function worker(): Promise<void> {
    while (queueIdx < queue.length) {
      const idx = queueIdx++;
      const task = queue[idx];
      if (!task) break;
      const result = await task();
      onResult(result);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => worker()),
  );
}

// ─── Core evaluator ───────────────────────────────────────────────────────────

async function evaluateQuestion(
  q: BenchmarkQuestion,
  datasourceId: string,
  model: string,
  metrics: string[],
  repos: Repositories,
): Promise<QuestionResult> {
  const t0 = Date.now();
  let conversationSlug: string | null = null;

  const failResult = (status: string, error: string): QuestionResult => ({
    question_id: q.question_id,
    db_id: q.db_id,
    datasource_id: datasourceId,
    difficulty: q.difficulty,
    question: q.question,
    gold_sql: q.SQL,
    predicted_sql: null,
    status,
    correct: false,
    ex_strict: false,
    ex_subset: false,
    ex_superset: false,
    f1_score: null,
    r_ves: null,
    gold_rows: null,
    gold_duration_ms: null,
    pred_duration_ms: null,
    duration_ms: Date.now() - t0,
    error,
    conversation_slug: conversationSlug,
  });

  // Step 1: Gold SQL (use pre-computed rows if provided by CLI cache)
  let goldRows: Record<string, unknown>[] = [];
  let goldDurationMs: number | null = null;

  if (q.gold_rows !== undefined) {
    goldRows = q.gold_rows;
    goldDurationMs = q.gold_duration_ms ?? null;
  } else {
    try {
      const r = await executeSqlWithTiming(datasourceId, q.SQL, repos);
      goldRows = r.rows;
      goldDurationMs = r.durationMs;
    } catch (err) {
      return failResult(
        'gold_sql_error',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Step 2: Agent prediction
  // prompt() is safe for concurrent calls: each invocation gets its own
  // AbortController, pendingRealtimeChunks array, sharedExtra object, and
  // assistantMessageId bound to a unique conversationSlug. Shared repositories
  // are accessed concurrently only for per-slug reads+writes, so no data races.
  let predictedSql: string | null = null;
  const questionText = q.question.trim();

  try {
    const slug = await createBenchmarkConversation(datasourceId, repos);
    conversationSlug = slug;
    const validated = await validateUIMessages({
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          content: questionText,
          parts: [{ type: 'text', text: questionText }],
          metadata: { datasources: [datasourceId] },
        },
      ],
    });
    const telemetry = await getTelemetry();

    const response = await prompt({
      conversationSlug: slug,
      messages: validated,
      model,
      datasources: [datasourceId],
      repositories: repos,
      telemetry,
      generateTitle: false,
      benchmarkMode: true,
      mcpServerUrl: `${process.env.QWERY_BASE_URL ?? 'http://localhost:4096'}/mcp`,
    });

    if (response.body) {
      predictedSql = await extractSqlFromStream(response.body);
    }
  } catch (err) {
    return failResult(
      'no_prediction',
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!predictedSql) {
    return failResult('no_prediction', 'Agent returned no SQL');
  }

  // Step 3: Execute predicted SQL
  let predRows: Record<string, unknown>[] = [];
  let predDurationMs: number | null = null;

  try {
    const r = await executeSqlWithTiming(datasourceId, predictedSql, repos);
    predRows = r.rows;
    predDurationMs = r.durationMs;
  } catch (err) {
    return {
      question_id: q.question_id,
      db_id: q.db_id,
      datasource_id: datasourceId,
      difficulty: q.difficulty,
      question: q.question,
      gold_sql: q.SQL,
      predicted_sql: predictedSql,
      status: 'pred_sql_error',
      correct: false,
      ex_strict: false,
      ex_subset: false,
      ex_superset: false,
      f1_score: null,
      r_ves: null,
      gold_rows: goldRows,
      gold_duration_ms: goldDurationMs,
      pred_duration_ms: null,
      duration_ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      conversation_slug: conversationSlug,
    };
  }

  // Step 4: EX metrics
  const ex = computeEX(goldRows, predRows);

  // Step 5: F1 (free — reuses same rows)
  const f1Score = metrics.includes('f1') ? computeF1(goldRows, predRows) : null;

  // Step 6: R-VES (single-pass ratio)
  let rVes: number | null = null;
  if (
    goldDurationMs !== null &&
    predDurationMs !== null &&
    predDurationMs > 0
  ) {
    rVes = ex.strict ? Math.min(goldDurationMs / predDurationMs, 1.0) : 0.0;
  }

  return {
    question_id: q.question_id,
    db_id: q.db_id,
    datasource_id: datasourceId,
    difficulty: q.difficulty,
    question: q.question,
    gold_sql: q.SQL,
    predicted_sql: predictedSql,
    status: 'evaluated',
    correct: ex.strict,
    ex_strict: ex.strict,
    ex_subset: ex.subset,
    ex_superset: ex.superset,
    f1_score: f1Score,
    r_ves: rVes,
    gold_rows: goldRows,
    gold_duration_ms: goldDurationMs,
    pred_duration_ms: predDurationMs,
    duration_ms: Date.now() - t0,
    error: null,
    conversation_slug: conversationSlug,
  };
}

// ─── Summary ─────────────────────────────────────────────────────────────────

const ATTEMPTED_STATUSES = new Set([
  'evaluated',
  'no_prediction',
  'pred_sql_error',
]);

function buildSummary(results: QuestionResult[]) {
  const attempted = results.filter((r) => ATTEMPTED_STATUSES.has(r.status));
  const total = attempted.length;
  const correct = attempted.filter((r) => r.ex_strict).length;

  const f1Scores = attempted
    .filter((r) => r.f1_score !== null)
    .map((r) => r.f1_score!);
  const f1Avg =
    f1Scores.length > 0
      ? f1Scores.reduce((a, b) => a + b, 0) / f1Scores.length
      : 0;

  const rves = attempted.filter((r) => r.r_ves !== null).map((r) => r.r_ves!);
  const rvesAvg =
    rves.length > 0 ? rves.reduce((a, b) => a + b, 0) / rves.length : 0;

  const byDifficulty = ['simple', 'moderate', 'challenging'].map((diff) => {
    const sub = attempted.filter((r) => r.difficulty === diff);
    const n = sub.length;
    const subF1 = sub
      .filter((r) => r.f1_score !== null)
      .map((r) => r.f1_score!);
    return {
      difficulty: diff,
      n,
      ex_strict: n > 0 ? sub.filter((r) => r.ex_strict).length / n : 0,
      ex_subset: n > 0 ? sub.filter((r) => r.ex_subset).length / n : 0,
      f1_avg:
        subF1.length > 0 ? subF1.reduce((a, b) => a + b, 0) / subF1.length : 0,
    };
  });

  return {
    total,
    correct,
    no_sql: attempted.filter((r) => r.status === 'no_prediction').length,
    ex_strict: total > 0 ? correct / total : 0,
    ex_subset:
      total > 0 ? attempted.filter((r) => r.ex_subset).length / total : 0,
    f1_avg: f1Avg,
    rves_avg: rvesAvg,
    by_difficulty: byDifficulty,
  };
}

// ─── Route factory ────────────────────────────────────────────────────────────

export function createBenchmarkRoutes(getRepos: () => Promise<Repositories>) {
  const app = new Hono();

  // POST / — batch benchmark run, streams SSE progress events
  app.post('/', zValidator('json', runBodySchema), async (c) => {
    try {
      const body = c.req.valid('json');
      const { questions, datasource_map, workers, metrics, model } = body;
      const resolvedModel = model ?? getDefaultModel();
      const repos = await getRepos();

      const encoder = new TextEncoder();
      const total = questions.length;
      let current = 0;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enqueue = (obj: unknown) => {
            try {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(obj)}\n\n`),
              );
            } catch {
              /* controller may be closed */
            }
          };

          // Heartbeat: send an SSE comment every 30 s so the connection is
          // never idle long enough to trigger Bun's idleTimeout.
          let heartbeatDone = false;
          const heartbeat = setInterval(() => {
            if (heartbeatDone) return;
            try {
              controller.enqueue(encoder.encode(': heartbeat\n\n'));
            } catch {
              /* stream already closed */
            }
          }, 30_000);

          const tasks = questions.map(
            (q) => async (): Promise<QuestionResult> => {
              const datasourceId = resolveDatasourceId(q.db_id, datasource_map);
              if (!datasourceId) {
                return {
                  question_id: q.question_id,
                  db_id: q.db_id,
                  datasource_id: '',
                  difficulty: q.difficulty,
                  question: q.question,
                  gold_sql: q.SQL,
                  predicted_sql: null,
                  status: 'no_datasource',
                  correct: false,
                  ex_strict: false,
                  ex_subset: false,
                  ex_superset: false,
                  f1_score: null,
                  r_ves: null,
                  gold_rows: null,
                  gold_duration_ms: null,
                  pred_duration_ms: null,
                  duration_ms: 0,
                  error: `db_id '${q.db_id}' not in datasource_map`,
                  conversation_slug: null,
                };
              }
              return evaluateQuestion(
                q,
                datasourceId,
                resolvedModel,
                metrics,
                repos,
              );
            },
          );

          const results: QuestionResult[] = [];

          await runWithConcurrency(tasks, workers, (result) => {
            current++;
            results.push(result);
            enqueue({ type: 'progress', current, total, result });
          });

          heartbeatDone = true;
          clearInterval(heartbeat);

          enqueue({ type: 'done', summary: buildSummary(results), results });
          try {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          } catch {
            /* already closed */
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    } catch (error) {
      return handleDomainException(error);
    }
  });

  // POST /query — lightweight SQL execution without conversationId overhead
  app.post('/query', zValidator('json', queryBodySchema), async (c) => {
    try {
      const { datasourceId, sql } = c.req.valid('json');
      const repos = await getRepos();
      const t0 = Date.now();
      const { rows } = await executeSqlWithTiming(datasourceId, sql, repos);
      return c.json({
        success: true,
        data: { rows, durationMs: Date.now() - t0 },
      });
    } catch (error) {
      return handleDomainException(error);
    }
  });

  return app;
}
