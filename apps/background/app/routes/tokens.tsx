import { getDailyStats, getModelStats, getTokenTotals } from '~/lib/tokens.server';
import { TokenUsageChart } from '~/components/charts/TokenUsageChart';
import { ModelTokenBreakdown } from '~/components/charts/ModelTokenBreakdown';
import type { Route } from './+types/tokens';

export async function loader() {
  const [daily, models, totals] = await Promise.all([
    getDailyStats(30),
    getModelStats(),
    getTokenTotals(),
  ]);
  return { daily, models, totals, hasData: process.env.QWERY_INTERNAL_DATABASE_URL !== undefined };
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function TokensPage({ loaderData }: Route.ComponentProps) {
  const { daily, models, totals, hasData } = loaderData;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Token Usage</h1>
        <p className="text-sm text-muted-foreground mt-1">
          LLM token consumption across all agent sessions — last 30 days
        </p>
      </div>

      {!hasData && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-4 text-sm text-amber-800 dark:text-amber-300">
          <strong>QWERY_INTERNAL_DATABASE_URL</strong> is not set. Token usage
          tracing requires a PostgreSQL connection.
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Sessions" value={fmt(totals.sessionCount)} />
        <StatCard label="Input tokens" value={fmt(totals.totalInput)} color="chart-2" />
        <StatCard label="Output tokens" value={fmt(totals.totalOutput)} color="chart-4" />
        <StatCard
          label="Reasoning tokens"
          value={fmt(totals.totalReasoning)}
          color="chart-5"
          sub="thinking models only"
        />
      </div>

      {/* Daily usage chart */}
      <div className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-medium mb-4">Daily Token Consumption (30 days)</h2>
        <TokenUsageChart data={daily} />
      </div>

      {/* Model breakdown */}
      <div className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-medium mb-4">Token Usage by Model</h2>
        <ModelTokenBreakdown data={models} />
      </div>

      {/* Model table */}
      {models.length > 0 && (
        <div className="rounded-lg border bg-card">
          <div className="px-4 py-3 border-b">
            <h2 className="text-sm font-medium">Model Details</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="text-left px-4 py-2">Model</th>
                <th className="text-left px-4 py-2">Provider</th>
                <th className="text-right px-4 py-2">Sessions</th>
                <th className="text-right px-4 py-2">Input</th>
                <th className="text-right px-4 py-2">Output</th>
                <th className="text-right px-4 py-2">Reasoning</th>
                <th className="text-right px-4 py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={`${m.provider_id}/${m.model_id}`} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-2 font-mono text-xs">{m.model_id}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{m.provider_id}</td>
                  <td className="px-4 py-2 text-right text-muted-foreground">{m.session_count}</td>
                  <td className="px-4 py-2 text-right">{fmt(m.input_tokens)}</td>
                  <td className="px-4 py-2 text-right">{fmt(m.output_tokens)}</td>
                  <td className="px-4 py-2 text-right text-muted-foreground">
                    {m.reasoning_tokens > 0 ? fmt(m.reasoning_tokens) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-medium">
                    {fmt(m.input_tokens + m.output_tokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string;
  color?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div
        className="text-2xl font-bold tabular-nums"
        style={color ? { color: `hsl(var(--${color}))` } : undefined}
      >
        {value}
      </div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
      {sub && <div className="text-xs text-muted-foreground/60 mt-0.5">{sub}</div>}
    </div>
  );
}
