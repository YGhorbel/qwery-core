'use client';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import type { FlatField } from '~/lib/storage.server';

type Props = { fields: FlatField[] };

export function FilterCoverageChart({ fields }: Props) {
  const buckets = [0, 1, 2, 3];
  const data = buckets.map((n) => ({
    label: n === 3 ? '3+' : String(n),
    count: fields.filter((f) => {
      const fc = (f.filters ?? []).length;
      return n === 3 ? fc >= 3 : fc === n;
    }).length,
  }));

  return (
    <ResponsiveContainer width="100%" height={160}>
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
        <XAxis dataKey="label" tick={{ fontSize: 12 }} label={{ value: 'Filters', position: 'insideBottom', offset: -2, fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
        <Tooltip formatter={(v) => [v, 'Fields']} labelFormatter={(l) => `${l} filter(s)`} />
        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
          {data.map((d, i) => (
            <Cell
              key={i}
              fill={
                d.label === '0'
                  ? 'var(--chart-5)'
                  : d.label === '1'
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
