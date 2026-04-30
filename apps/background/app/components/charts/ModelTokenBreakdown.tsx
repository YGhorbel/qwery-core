'use client';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import type { ModelTokenStat } from '~/lib/tokens.server';

type Props = { data: ModelTokenStat[] };

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function ModelTokenBreakdown({ data }: Props) {
  if (data.length === 0)
    return <p className="text-sm text-muted-foreground">No data yet.</p>;

  const chartData = data.slice(0, 8).map((d) => ({
    model: d.model_id.length > 20 ? d.model_id.slice(0, 18) + '…' : d.model_id,
    fullModel: d.model_id,
    Input: d.input_tokens,
    Output: d.output_tokens,
    Reasoning: d.reasoning_tokens,
    Sessions: d.session_count,
  }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart
        data={chartData}
        layout="vertical"
        margin={{ top: 8, right: 24, bottom: 8, left: 8 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
        <XAxis type="number" tickFormatter={fmt} tick={{ fontSize: 11 }} />
        <YAxis
          type="category"
          dataKey="model"
          width={120}
          tick={{ fontSize: 10 }}
        />
        <Tooltip
          formatter={(v: number, name: string) => [fmt(v), name]}
          labelFormatter={(label: string) => {
            const item = chartData.find((d) => d.model === label);
            return item?.fullModel ?? label;
          }}
        />
        <Legend />
        <Bar dataKey="Input" stackId="a" fill="var(--chart-2)" />
        <Bar dataKey="Output" stackId="a" fill="var(--chart-4)" />
        <Bar dataKey="Reasoning" stackId="a" fill="var(--chart-5)" radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
