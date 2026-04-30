import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@qwery/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qwery/ui/table';
import { getTraceStats } from '~/lib/traces.server';
import { IntentDistribution } from '~/components/charts/IntentDistribution';
import type { Route } from './+types/datasources.$id.traces';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export async function loader({ params }: Route.LoaderArgs) {
  const stats = await getTraceStats(params.id);
  return {
    id: params.id,
    stats,
    hasInternalDb: !!process.env.QWERY_INTERNAL_DATABASE_URL,
  };
}

export default function TracesPage({ loaderData }: Route.ComponentProps) {
  const { id, stats, hasInternalDb } = loaderData;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link
          to={`/datasources/${id}`}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold">Query Traces</h1>
        <Badge variant="secondary" className="ml-2">
          {stats.total} traces
        </Badge>
        {stats.total > 0 && (
          <span className="text-sm text-muted-foreground ml-auto">
            Correction rate:{' '}
            <strong>{Math.round(stats.correctionRate * 100)}%</strong>
          </span>
        )}
      </div>

      {stats.total === 0 ? (
        <p className="text-muted-foreground text-sm">
          No traces yet — run some queries first.{' '}
          {!hasInternalDb && (
            <span className="text-amber-600">
              QWERY_INTERNAL_DATABASE_URL is not set.
            </span>
          )}
        </p>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 space-y-4">
            <div className="rounded-lg border bg-card p-4">
              <h3 className="text-sm font-medium mb-3">Recent Traces</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Question</TableHead>
                    <TableHead>Intent</TableHead>
                    <TableHead>Complexity</TableHead>
                    <TableHead>Path</TableHead>
                    <TableHead>Corrected</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.recentTraces.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="max-w-xs">
                        <p className="truncate text-sm">{t.question}</p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs font-mono">
                          {t.intent}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">{t.complexity}</TableCell>
                      <TableCell>
                        <PathBadge path={t.path_used} />
                      </TableCell>
                      <TableCell>
                        {t.correction_applied ? (
                          <Badge variant="secondary" className="text-xs">Yes</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">No</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(t.created_at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <div className="space-y-6">
            <ChartCard title="Intent Distribution">
              <IntentDistribution data={stats.intentDistribution} />
            </ChartCard>
            <ChartCard title="Complexity">
              <SimpleBarChart data={stats.complexityDistribution} />
            </ChartCard>
            <ChartCard title="Path Winner">
              <SimpleBarChart data={stats.pathDistribution} color="hsl(var(--chart-3))" />
            </ChartCard>
          </div>
        </div>
      )}
    </div>
  );
}

function PathBadge({ path }: { path: number }) {
  const labels: Record<number, string> = { 1: 'Heuristic', 2: 'Agent', 3: 'CoT' };
  const variants: Record<number, 'default' | 'secondary' | 'outline'> = {
    1: 'outline',
    2: 'secondary',
    3: 'default',
  };
  return (
    <Badge variant={variants[path] ?? 'outline'} className="text-xs">
      {labels[path] ?? `P${path}`}
    </Badge>
  );
}

function SimpleBarChart({
  data,
  color = 'hsl(var(--chart-2))',
}: {
  data: { name: string; value: number }[];
  color?: string;
}) {
  if (data.length === 0)
    return <p className="text-xs text-muted-foreground">No data</p>;
  return (
    <ResponsiveContainer width="100%" height={140}>
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 0 }}>
        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
        <Tooltip />
        <Bar dataKey="value" fill={color} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="text-sm font-medium mb-3">{title}</h3>
      {children}
    </div>
  );
}
