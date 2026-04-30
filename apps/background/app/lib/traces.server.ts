import { Pool } from 'pg';

let pool: Pool | null = null;

function getPool(): Pool | null {
  const url = process.env.QWERY_INTERNAL_DATABASE_URL;
  if (!url) return null;
  if (!pool) pool = new Pool({ connectionString: url, max: 3 });
  return pool;
}

export type TraceRow = {
  id: string;
  question: string;
  intent: string;
  complexity: number;
  path_used: number;
  correction_applied: unknown;
  success: boolean;
  created_at: string;
};

export type TraceStats = {
  total: number;
  intentDistribution: { name: string; value: number }[];
  complexityDistribution: { name: string; value: number }[];
  pathDistribution: { name: string; value: number }[];
  correctionRate: number;
  recentTraces: TraceRow[];
};

export async function getTraceStats(
  datasourceId: string,
): Promise<TraceStats> {
  const p = getPool();
  if (!p) {
    return {
      total: 0,
      intentDistribution: [],
      complexityDistribution: [],
      pathDistribution: [],
      correctionRate: 0,
      recentTraces: [],
    };
  }

  const client = await p.connect();
  try {
    const res = await client.query<TraceRow>(
      `SELECT id, question, intent, complexity, path_used,
              correction_applied, success, created_at
       FROM query_traces
       WHERE datasource_id = $1 AND success = true
       ORDER BY created_at DESC
       LIMIT 200`,
      [datasourceId],
    );

    const traces = res.rows;
    const intentMap: Record<string, number> = {};
    const complexityMap: Record<string, number> = {};
    const pathMap: Record<string, number> = {};
    let corrected = 0;

    for (const t of traces) {
      intentMap[t.intent] = (intentMap[t.intent] ?? 0) + 1;
      const c = `Complexity ${t.complexity}`;
      complexityMap[c] = (complexityMap[c] ?? 0) + 1;
      const pLabel =
        t.path_used === 1
          ? 'Heuristic'
          : t.path_used === 2
            ? 'Agent SQL'
            : 'CoT';
      pathMap[pLabel] = (pathMap[pLabel] ?? 0) + 1;
      if (t.correction_applied) corrected++;
    }

    return {
      total: traces.length,
      intentDistribution: Object.entries(intentMap).map(([name, value]) => ({
        name,
        value,
      })),
      complexityDistribution: Object.entries(complexityMap).map(
        ([name, value]) => ({ name, value }),
      ),
      pathDistribution: Object.entries(pathMap).map(([name, value]) => ({
        name,
        value,
      })),
      correctionRate: traces.length > 0 ? corrected / traces.length : 0,
      recentTraces: traces.slice(0, 20),
    };
  } catch {
    return {
      total: 0,
      intentDistribution: [],
      complexityDistribution: [],
      pathDistribution: [],
      correctionRate: 0,
      recentTraces: [],
    };
  } finally {
    client.release();
  }
}
