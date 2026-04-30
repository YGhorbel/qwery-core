'use client';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from 'recharts';
import type { FlatField } from '~/lib/storage.server';

type Props = { fields: FlatField[] };

export function ConfidenceChart({ fields }: Props) {
  const data = fields
    .map((f) => ({
      id: f.id.split('.').pop() ?? f.id,
      fullId: f.id,
      label: f.label ?? f.id,
      confidence: Math.round((f.confidence ?? 0.7) * 100),
      flagged: f.flagged ?? false,
    }))
    .sort((a, b) => a.confidence - b.confidence)
    .slice(0, 30);

  if (data.length === 0)
    return <p className="text-sm text-muted-foreground">No fields</p>;

  return (
    <ResponsiveContainer width="100%" height={Math.max(200, data.length * 22)}>
      <BarChart
        layout="vertical"
        data={data}
        margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
      >
        <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} />
        <YAxis
          type="category"
          dataKey="label"
          width={130}
          tick={{ fontSize: 11 }}
          tickFormatter={(v: string) =>
            v.length > 18 ? v.slice(0, 17) + '…' : v
          }
        />
        <Tooltip
          formatter={(v) => [`${v}%`, 'Confidence']}
          labelFormatter={(_, payload) => payload[0]?.payload?.fullId ?? ''}
        />
        <ReferenceLine x={50} stroke="hsl(var(--destructive))" strokeDasharray="4 2" />
        <ReferenceLine x={70} stroke="var(--chart-4)" strokeDasharray="4 2" />
        <Bar dataKey="confidence" radius={[0, 3, 3, 0]}>
          {data.map((entry) => (
            <Cell
              key={entry.id}
              fill={
                entry.flagged
                  ? 'hsl(var(--destructive))'
                  : entry.confidence < 50
                    ? 'var(--chart-5)'
                    : entry.confidence < 70
                      ? 'var(--chart-4)'
                      : 'var(--chart-2)'
              }
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
