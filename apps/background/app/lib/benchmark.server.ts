import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { storageDir } from './storage.server';

const runsDir = () => join(storageDir(), 'benchmark-runs');

export type DifficultyStats = {
  difficulty: string;
  n: number;
  ex_strict: number;
  ex_subset: number;
  f1_avg: number;
};

export type BenchmarkSummary = {
  total: number;
  correct: number;
  no_sql: number;
  ex_strict: number;
  ex_subset: number;
  f1_avg: number;
  rves_avg: number;
  by_difficulty: DifficultyStats[];
};

export type QuestionResult = {
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
  gold_duration_ms: number | null;
  pred_duration_ms: number | null;
  duration_ms: number;
  error: string | null;
  conversation_slug?: string | null;
};

export type BenchmarkRun = {
  id: string;
  timestamp: string;
  model?: string;
  summary: BenchmarkSummary;
  results: QuestionResult[];
};

export type BenchmarkRunMeta = Omit<BenchmarkRun, 'results'> & {
  datasourceIds: string[];
};

export async function listRuns(): Promise<BenchmarkRunMeta[]> {
  const dir = runsDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const runs = await Promise.all(
    files.map(async (file) => {
      try {
        const raw = await readFile(join(dir, file), 'utf-8');
        const run = JSON.parse(raw) as BenchmarkRun;
        const datasourceIds = [
          ...new Set(
            run.results.map((r) => r.datasource_id).filter(Boolean),
          ),
        ];
        return { id: run.id, timestamp: run.timestamp, model: run.model, summary: run.summary, datasourceIds };
      } catch {
        return null;
      }
    }),
  );

  return (runs.filter(Boolean) as BenchmarkRunMeta[]).sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  );
}

export async function getRun(id: string): Promise<BenchmarkRun | null> {
  try {
    const raw = await readFile(join(runsDir(), `run_${id}.json`), 'utf-8');
    return JSON.parse(raw) as BenchmarkRun;
  } catch {
    return null;
  }
}

export async function saveRun(run: BenchmarkRun): Promise<void> {
  await mkdir(runsDir(), { recursive: true });
  await writeFile(
    join(runsDir(), `run_${run.id}.json`),
    JSON.stringify(run, null, 2),
  );
}
