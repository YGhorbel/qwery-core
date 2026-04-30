'use client';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';

type Props = {
  measures: number;
  dimensions: number;
  businessRules: number;
};

const COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
];

export function FieldTypeDonut({ measures, dimensions, businessRules }: Props) {
  const data = [
    { name: 'Measures', value: measures },
    { name: 'Dimensions', value: dimensions },
    { name: 'Business Rules', value: businessRules },
  ].filter((d) => d.value > 0);

  if (data.length === 0)
    return <p className="text-sm text-muted-foreground">No fields</p>;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="45%"
          innerRadius={55}
          outerRadius={80}
          paddingAngle={3}
          dataKey="value"
          label={({ name, percent }) =>
            `${name} ${(percent * 100).toFixed(0)}%`
          }
          labelLine={false}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(v, name) => [v, name]} />
      </PieChart>
    </ResponsiveContainer>
  );
}
