'use client';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import type { DailyTokenStat } from '~/lib/tokens.server';

type Props = { data: DailyTokenStat[] };

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function TokenUsageChart({ data }: Props) {
  if (data.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No token usage recorded yet.
      </p>
    );

  const chartData = data.map((d) => ({
    date: new Date(d.date).toLocaleDateString('en', { month: 'short', day: 'numeric' }),
    Input: d.input_tokens,
    Output: d.output_tokens,
    Reasoning: d.reasoning_tokens,
  }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
        <defs>
          <linearGradient id="colorInput" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-2)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--chart-2)" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="colorOutput" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-4)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--chart-4)" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="colorReasoning" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-5)" stopOpacity={0.25} />
            <stop offset="95%" stopColor="var(--chart-5)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
        <YAxis tickFormatter={fmt} tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v: number) => fmt(v)} />
        <Legend />
        <Area
          type="monotone"
          dataKey="Input"
          stroke="var(--chart-2)"
          strokeWidth={2}
          fill="url(#colorInput)"
          dot={false}
        />
        <Area
          type="monotone"
          dataKey="Output"
          stroke="var(--chart-4)"
          strokeWidth={2}
          fill="url(#colorOutput)"
          dot={false}
        />
        <Area
          type="monotone"
          dataKey="Reasoning"
          stroke="var(--chart-5)"
          strokeWidth={1.5}
          strokeDasharray="4 2"
          fill="url(#colorReasoning)"
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
