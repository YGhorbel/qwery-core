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
import type { DifficultyStats } from '~/lib/benchmark.server';

type Props = { byDifficulty: DifficultyStats[] };

export function BenchmarkByDifficulty({ byDifficulty }: Props) {
  const data = byDifficulty
    .filter((d) => d.n > 0)
    .map((d) => ({
      name: d.difficulty.charAt(0).toUpperCase() + d.difficulty.slice(1),
      'EX Strict': Math.round(d.ex_strict * 100),
      'EX Subset': Math.round(d.ex_subset * 100),
      'F1 Avg': Math.round(d.f1_avg * 100),
      n: d.n,
    }));

  if (data.length === 0)
    return <p className="text-sm text-muted-foreground">No data</p>;

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 12 }}
          tickFormatter={(v, i) => `${v} (n=${data[i]?.n ?? 0})`}
        />
        <YAxis
          tickFormatter={(v) => `${v}%`}
          domain={[0, 100]}
          tick={{ fontSize: 11 }}
        />
        <Tooltip formatter={(v) => `${v}%`} />
        <Legend />
        <Bar dataKey="EX Strict" fill="var(--chart-2)" radius={[3, 3, 0, 0]} />
        <Bar dataKey="EX Subset" fill="var(--chart-3)" radius={[3, 3, 0, 0]} />
        <Bar dataKey="F1 Avg" fill="var(--chart-4)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
