'use client';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
  type TooltipProps,
} from 'recharts';
import type { BenchmarkRunMeta } from '~/lib/benchmark.server';

type Props = { runs: BenchmarkRunMeta[] };

function CustomTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border bg-popover text-popover-foreground shadow-md px-3 py-2 text-xs space-y-1">
      <p className="font-medium mb-1">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-medium">{p.value}%</span>
        </div>
      ))}
    </div>
  );
}

export function BenchmarkTrend({ runs }: Props) {
  if (runs.length < 2)
    return (
      <p className="text-sm text-muted-foreground">
        Run at least 2 benchmarks to see the trend
      </p>
    );

  const data = [...runs]
    .reverse()
    .map((r) => ({
      date: new Date(r.timestamp).toLocaleDateString('en', {
        month: 'short',
        day: 'numeric',
      }),
      'EX Strict': Math.round(r.summary.ex_strict * 100),
      'EX Subset': Math.round(r.summary.ex_subset * 100),
      'F1 Avg': Math.round(r.summary.f1_avg * 100),
    }));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <defs>
          <linearGradient id="exStrictGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-2)" stopOpacity={0.25} />
            <stop offset="95%" stopColor="var(--chart-2)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
        <YAxis
          tickFormatter={(v) => `${v}%`}
          domain={[0, 100]}
          tick={{ fontSize: 11 }}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <ReferenceLine
          y={70}
          stroke="var(--chart-2)"
          strokeDasharray="6 3"
          strokeOpacity={0.5}
          label={{ value: '70%', position: 'right', fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
        />
        <Area
          type="monotone"
          dataKey="EX Strict"
          stroke="var(--chart-2)"
          strokeWidth={2}
          fill="url(#exStrictGrad)"
          dot={{ r: 3, fill: 'var(--chart-2)' }}
          activeDot={{ r: 5 }}
        />
        <Line
          type="monotone"
          dataKey="EX Subset"
          stroke="var(--chart-2)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          strokeOpacity={0.7}
          dot={{ r: 2 }}
        />
        <Line
          type="monotone"
          dataKey="F1 Avg"
          stroke="var(--chart-4)"
          strokeWidth={2}
          dot={{ r: 3 }}
          activeDot={{ r: 5 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
