/**
 * BIRD NL2SQL benchmark CLI — TypeScript replacement for runner.py
 *
 * Usage:
 *   bun apps/server/src/cli/benchmark.ts \
 *     --questions /path/to/questions.json \
 *     --datasource-map '{"formula_1":"uuid"}' \
 *     --limit 50 --workers 5 --metrics ex,f1 \
 *     --server http://localhost:4096
 *
 *   Or via package script:
 *   pnpm --filter server benchmark -- --questions /path/to/questions.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve, join } from 'path';

// ─── Argument parsing ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? argv[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return argv.includes(flag);
}

const questionsPath = getArg('--questions');
const datasourceMapArg = getArg('--datasource-map');
const limitArg = getArg('--limit');
const workersArg = getArg('--workers');
const metricsArg = getArg('--metrics') ?? 'ex,f1';
const dbFilter = getArg('--db');
const difficultyFilter = getArg('--difficulty');
const serverUrl = getArg('--server') ?? 'http://localhost:4096';
const outputArg = getArg('--output');
const noCacheFlag = hasFlag('--no-cache');
const cachePathArg = getArg('--cache-path');
const modelArg = getArg('--model');

if (!questionsPath) {
  console.error('Error: --questions <path> is required');
  process.exit(1);
}

const limit = limitArg ? parseInt(limitArg, 10) : undefined;
const workers = workersArg ? parseInt(workersArg, 10) : 5;
const metrics = metricsArg
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

// ─── Load datasource map ──────────────────────────────────────────────────────

function loadDatasourceMap(): Record<string, string> {
  if (datasourceMapArg) {
    // Try as file path first, then inline JSON
    if (existsSync(datasourceMapArg)) {
      return JSON.parse(readFileSync(datasourceMapArg, 'utf-8')) as Record<
        string,
        string
      >;
    }
    try {
      return JSON.parse(datasourceMapArg) as Record<string, string>;
    } catch {
      console.error(
        'Error: --datasource-map must be a valid JSON string or file path',
      );
      process.exit(1);
    }
  }
  if (process.env.DATASOURCE_MAP) {
    try {
      return JSON.parse(process.env.DATASOURCE_MAP) as Record<string, string>;
    } catch {
      console.error('Error: DATASOURCE_MAP env var is not valid JSON');
      process.exit(1);
    }
  }
  return {};
}

// ─── Load questions ───────────────────────────────────────────────────────────

type Question = {
  question_id: number;
  db_id: string;
  question: string;
  evidence?: string;
  SQL: string;
  difficulty?: string;
  gold_rows?: Record<string, unknown>[];
  gold_duration_ms?: number;
};

function loadQuestions(path: string): Question[] {
  const text = readFileSync(path, 'utf-8').trim();
  if (text.startsWith('[')) {
    return JSON.parse(text) as Question[];
  }
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Question);
}

// ─── Gold cache ───────────────────────────────────────────────────────────────

type GoldCacheEntry = {
  status: 'ok' | 'error' | 'no_datasource';
  rows: Record<string, unknown>[] | null;
  gold_duration_ms: number | null;
  error?: string;
};

type GoldCache = Record<string, GoldCacheEntry>;

const resolvedQuestionsPath = resolve(questionsPath);
const defaultCachePath = join(
  dirname(resolvedQuestionsPath),
  'gold_cache.json',
);
const cachePath = cachePathArg ? resolve(cachePathArg) : defaultCachePath;

function loadGoldCache(): GoldCache {
  if (!existsSync(cachePath)) return {};
  try {
    return JSON.parse(readFileSync(cachePath, 'utf-8')) as GoldCache;
  } catch {
    return {};
  }
}

function saveGoldCache(cache: GoldCache): void {
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

// ─── Result types ─────────────────────────────────────────────────────────────

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
};

type ProgressEvent = {
  type: 'progress';
  current: number;
  total: number;
  result: QuestionResult;
};

type DifficultyStats = {
  difficulty: string;
  n: number;
  ex_strict: number;
  ex_subset: number;
  f1_avg: number;
};

type DoneEvent = {
  type: 'done';
  summary: {
    total: number;
    correct: number;
    no_sql: number;
    ex_strict: number;
    ex_subset: number;
    f1_avg: number;
    rves_avg: number;
    by_difficulty: DifficultyStats[];
  };
  results: QuestionResult[];
};

// ─── Auth header ──────────────────────────────────────────────────────────────

function authHeader(): Record<string, string> {
  const password = process.env.QWERY_SERVER_PASSWORD;
  if (!password) return {};
  const username = process.env.QWERY_SERVER_USERNAME ?? 'qwery';
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  };
}

// ─── Progress display ─────────────────────────────────────────────────────────

function formatResult(r: QuestionResult): string {
  const strict = r.ex_strict ? '✓' : r.correct === false ? '✗' : '—';
  const sub = r.ex_subset ? '✓' : '✗';
  const f1 = r.f1_score !== null ? ` f1=${r.f1_score.toFixed(2)}` : '';
  const dur = `${(r.duration_ms / 1000).toFixed(1)}s`;
  return (
    `  [done]  q${String(r.question_id).padStart(4)} | ${r.status.padEnd(18)} | ` +
    `strict=${strict} sub=${sub}${f1.padEnd(9)} | ${dur}`
  );
}

function printSummary(summary: DoneEvent['summary']): void {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const s = summary.by_difficulty.find((d) => d.difficulty === 'simple') ?? {
    n: 0,
    ex_strict: 0,
    ex_subset: 0,
    f1_avg: 0,
  };
  const m = summary.by_difficulty.find((d) => d.difficulty === 'moderate') ?? {
    n: 0,
    ex_strict: 0,
    ex_subset: 0,
    f1_avg: 0,
  };
  const ch = summary.by_difficulty.find(
    (d) => d.difficulty === 'challenging',
  ) ?? { n: 0, ex_strict: 0, ex_subset: 0, f1_avg: 0 };

  console.log(`
=== BENCHMARK RESULTS ===
Questions: ${summary.total} | No SQL: ${summary.no_sql} (${pct(summary.no_sql / (summary.total || 1))})

Overall
  EX strict:   ${pct(summary.ex_strict)}   (exact set match)
  EX subset:   ${pct(summary.ex_subset)}   (correct + extra columns ok)
  F1 avg:      ${summary.f1_avg.toFixed(3)}
  R-VES avg:   ${summary.rves_avg.toFixed(3)}

By difficulty
  Simple      EX strict: ${pct(s.ex_strict)}  EX subset: ${pct(s.ex_subset)}  F1: ${s.f1_avg.toFixed(3)}  (n=${s.n})
  Moderate    EX strict: ${pct(m.ex_strict)}  EX subset: ${pct(m.ex_subset)}  F1: ${m.f1_avg.toFixed(3)}  (n=${m.n})
  Challenging EX strict: ${pct(ch.ex_strict)}  EX subset: ${pct(ch.ex_subset)}  F1: ${ch.f1_avg.toFixed(3)}  (n=${ch.n})
`);
}

// ─── SSE stream consumer ──────────────────────────────────────────────────────

async function consumeSSE(
  response: Response,
  onProgress: (evt: ProgressEvent) => void,
): Promise<DoneEvent> {
  if (!response.body) throw new Error('Response body is empty');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let doneEvent: DoneEvent | null = null;

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

        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') break;

        try {
          const evt = JSON.parse(payload) as ProgressEvent | DoneEvent;
          if (evt.type === 'progress') {
            onProgress(evt);
          } else if (evt.type === 'done') {
            doneEvent = evt;
          }
        } catch {
          /* non-JSON data line */
        }
      }
      buf = buf.slice(from);
    }
  } finally {
    reader.releaseLock();
  }

  if (!doneEvent) throw new Error('Stream ended without a done event');
  return doneEvent;
}

// ─── Save results ─────────────────────────────────────────────────────────────

function saveResults(results: QuestionResult[], outPath: string): void {
  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const output = results.map((r) => {
    // Strip gold_rows from saved results (large, available in cache)
    const { gold_rows: _gr, ...rest } = r;
    return rest;
  });

  writeFileSync(outPath, JSON.stringify(output, null, 2));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const datasourceMap = loadDatasourceMap();
  let questions = loadQuestions(resolvedQuestionsPath);

  // Apply filters
  if (dbFilter) {
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const filterIsUUID = UUID_RE.test(dbFilter);
    questions = questions.filter((q) => {
      if (filterIsUUID) return q.db_id === dbFilter;
      const mapped = datasourceMap[dbFilter];
      return q.db_id === dbFilter || (mapped ? q.db_id === mapped : false);
    });
  }
  if (difficultyFilter) {
    questions = questions.filter((q) => q.difficulty === difficultyFilter);
  }
  if (limit !== undefined) {
    questions = questions.slice(0, limit);
  }

  if (questions.length === 0) {
    console.error('No questions match the specified filters.');
    process.exit(1);
  }

  // Gold cache
  let goldCache: GoldCache = {};
  if (!noCacheFlag && existsSync(cachePath)) {
    goldCache = loadGoldCache();
    const cached = questions.filter(
      (q) => goldCache[String(q.question_id)]?.status === 'ok',
    ).length;
    console.log(
      `[cache] loaded gold results for ${Object.keys(goldCache).length} questions ` +
        `(${cached}/${questions.length} applicable) from ${cachePath}`,
    );
  } else if (!noCacheFlag) {
    console.log(
      `[cache] no cache found at ${cachePath} — server will execute gold SQL`,
    );
  } else {
    console.log('[cache] --no-cache flag set — skipping gold cache');
  }

  // Pre-populate gold_rows from cache
  const questionsWithCache = questions.map((q) => {
    const entry = goldCache[String(q.question_id)];
    if (entry?.status === 'ok' && entry.rows !== null) {
      return {
        ...q,
        gold_rows: entry.rows,
        gold_duration_ms: entry.gold_duration_ms ?? undefined,
      };
    }
    return q;
  });

  console.log(
    `\n[bench] ${questions.length} questions | metrics=${metrics.join(',')} | ` +
      `workers=${workers} | cache=${noCacheFlag ? 'off' : 'on'}`,
  );

  // Output path
  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\..+/, '')
    .slice(0, 15);
  const defaultOutput = resolve(
    dirname(resolvedQuestionsPath),
    `results/run_${ts}.json`,
  );
  const outputPath = outputArg ? resolve(outputArg) : defaultOutput;

  // Call server
  const requestBody = {
    questions: questionsWithCache,
    datasource_map: datasourceMap,
    workers,
    metrics,
    ...(modelArg ? { model: modelArg } : {}),
  };

  console.log(`[bench] posting to ${serverUrl}/api/benchmark …\n`);

  const response = await fetch(`${serverUrl}/api/benchmark`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`Server error ${response.status}: ${body}`);
    process.exit(1);
  }

  const doneEvent = await consumeSSE(response, (evt) => {
    console.log(formatResult(evt.result));
  });

  printSummary(doneEvent.summary);

  // Update gold cache with newly computed rows
  let cacheUpdated = false;
  for (const result of doneEvent.results) {
    const key = String(result.question_id);
    if (
      !goldCache[key] &&
      result.gold_rows !== null &&
      result.status !== 'no_datasource'
    ) {
      goldCache[key] = {
        status: result.status === 'gold_sql_error' ? 'error' : 'ok',
        rows: result.gold_rows,
        gold_duration_ms: result.gold_duration_ms,
      };
      cacheUpdated = true;
    }
  }

  if (cacheUpdated && !noCacheFlag) {
    saveGoldCache(goldCache);
    console.log(
      `[cache] saved gold results for ${Object.keys(goldCache).length} questions → ${cachePath}`,
    );
  }

  saveResults(doneEvent.results, outputPath);
  console.log(`[bench] results saved → ${outputPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
