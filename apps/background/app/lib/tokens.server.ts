const serverUrl = () => process.env.QWERY_SERVER_URL ?? 'http://localhost:4096';

export type DailyTokenStat = {
  date: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
};

export type ModelTokenStat = {
  model_id: string;
  provider_id: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  session_count: number;
};

export type TokenTotals = {
  totalInput: number;
  totalOutput: number;
  totalReasoning: number;
  sessionCount: number;
};

type StatsResponse = {
  daily: DailyTokenStat[];
  models: ModelTokenStat[];
  totals: TokenTotals;
};

const empty: StatsResponse = {
  daily: [],
  models: [],
  totals: { totalInput: 0, totalOutput: 0, totalReasoning: 0, sessionCount: 0 },
};

let _cache: StatsResponse | null = null;
let _cacheAt = 0;

async function fetchStats(): Promise<StatsResponse> {
  const now = Date.now();
  if (_cache && now - _cacheAt < 30_000) return _cache;
  try {
    const res = await fetch(`${serverUrl()}/api/tokens/stats`);
    if (!res.ok) return empty;
    _cache = (await res.json()) as StatsResponse;
    _cacheAt = now;
    return _cache;
  } catch {
    return empty;
  }
}

export async function getDailyStats(_days = 30): Promise<DailyTokenStat[]> {
  return (await fetchStats()).daily;
}

export async function getModelStats(): Promise<ModelTokenStat[]> {
  return (await fetchStats()).models;
}

export async function getTokenTotals(): Promise<TokenTotals> {
  return (await fetchStats()).totals;
}
