'use client';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { QuestionResult } from '~/lib/benchmark.server';

type Props = { results: QuestionResult[] };

const STATUS_COLORS: Record<string, string> = {
  evaluated: 'var(--chart-2)',
  no_prediction: 'var(--chart-5)',
  pred_sql_error: 'var(--chart-1)',
  gold_sql_error: 'var(--chart-4)',
  no_datasource: 'hsl(var(--muted-foreground))',
};

export function StatusBreakdown({ results }: Props) {
  const counts: Record<string, number> = {};
  for (const r of results) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  }

  const data = Object.entries(counts).map(([name, value]) => ({
    name: name.replace(/_/g, ' '),
    rawName: name,
    value,
  }));

  if (data.length === 0)
    return <p className="text-sm text-muted-foreground">No results</p>;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="45%"
          outerRadius={75}
          paddingAngle={2}
          dataKey="value"
        >
          {data.map((d, i) => (
            <Cell
              key={i}
              fill={STATUS_COLORS[d.rawName] ?? `var(--chart-${(i % 5) + 1})`}
            />
          ))}
        </Pie>
        <Tooltip formatter={(v, name) => [v, name]} />
        <Legend iconType="circle" iconSize={10} />
      </PieChart>
    </ResponsiveContainer>
  );
}
