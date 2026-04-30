import { Link } from 'react-router';
import { AlertTriangle, ArrowLeft, CheckCircle, History } from 'lucide-react';
import { Badge } from '@qwery/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@qwery/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qwery/ui/table';
import {
  getSemanticLayer,
  getMeasureCandidates,
  flattenLayer,
} from '~/lib/storage.server';
import { ConfidenceChart } from '~/components/charts/ConfidenceChart';
import { FieldTypeDonut } from '~/components/charts/FieldTypeDonut';
import { FilterCoverageChart } from '~/components/charts/FilterCoverageChart';
import type { Route } from './+types/datasources.$id';

export async function loader({ params }: Route.LoaderArgs) {
  const { id } = params;
  const [layer, candidates] = await Promise.all([
    getSemanticLayer(id),
    getMeasureCandidates(id),
  ]);

  return {
    id,
    layer,
    candidates,
    fields: layer ? flattenLayer(layer) : [],
  };
}

export default function DatasourcePage({ loaderData }: Route.ComponentProps) {
  const { id, layer, candidates, fields } = loaderData;

  const measures = fields.filter((f) => f.fieldType === 'measure');
  const dimensions = fields.filter((f) => f.fieldType === 'dimension');
  const rules = fields.filter((f) => f.fieldType === 'business_rule');
  const flagged = fields.filter((f) => f.flagged);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link
          to="/"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold font-mono">{id}</h1>
        <Link
          to={`/datasources/${id}/traces`}
          className="ml-auto flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <History className="h-4 w-4" />
          Query Traces
        </Link>
      </div>

      {!layer ? (
        <p className="text-muted-foreground text-sm">
          No semantic layer found for this datasource.
        </p>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2">
            <Tabs defaultValue="measures">
              <TabsList>
                <TabsTrigger value="measures">
                  Measures ({measures.length})
                </TabsTrigger>
                <TabsTrigger value="dimensions">
                  Dimensions ({dimensions.length})
                </TabsTrigger>
                <TabsTrigger value="rules">Rules ({rules.length})</TabsTrigger>
                {candidates.length > 0 && (
                  <TabsTrigger value="candidates">
                    Candidates ({candidates.length})
                  </TabsTrigger>
                )}
                {flagged.length > 0 && (
                  <TabsTrigger value="flagged">
                    <AlertTriangle className="h-3.5 w-3.5 mr-1 text-destructive" />
                    Flagged ({flagged.length})
                  </TabsTrigger>
                )}
              </TabsList>

              <TabsContent value="measures" className="mt-4">
                <FieldTable fields={measures} />
              </TabsContent>
              <TabsContent value="dimensions" className="mt-4">
                <FieldTable fields={dimensions} />
              </TabsContent>
              <TabsContent value="rules" className="mt-4">
                <FieldTable fields={rules} />
              </TabsContent>
              {candidates.length > 0 && (
                <TabsContent value="candidates" className="mt-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Expression</TableHead>
                        <TableHead>From Question</TableHead>
                        <TableHead>Proposed</TableHead>
                        <TableHead>Validated</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {candidates.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell>
                            <code className="text-xs font-mono bg-muted px-1 py-0.5 rounded">
                              {c.expression}
                            </code>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                            {c.question}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {new Date(c.proposedAt).toLocaleDateString()}
                          </TableCell>
                          <TableCell>
                            {c.validated ? (
                              <CheckCircle className="h-4 w-4 text-green-500" />
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                Pending
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TabsContent>
              )}
              {flagged.length > 0 && (
                <TabsContent value="flagged" className="mt-4">
                  <FieldTable fields={flagged} showReason />
                </TabsContent>
              )}
            </Tabs>
          </div>

          <div className="space-y-6">
            <ChartCard title="Field Types">
              <FieldTypeDonut
                measures={measures.length}
                dimensions={dimensions.length}
                businessRules={rules.length}
              />
            </ChartCard>
            <ChartCard title="Confidence (bottom 30)">
              <ConfidenceChart fields={fields} />
            </ChartCard>
            <ChartCard title="Filter Coverage">
              <FilterCoverageChart fields={[...measures, ...dimensions]} />
            </ChartCard>
          </div>
        </div>
      )}
    </div>
  );
}

function FieldTable({
  fields,
  showReason,
}: {
  fields: ReturnType<typeof flattenLayer>;
  showReason?: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>ID</TableHead>
          <TableHead>Label</TableHead>
          <TableHead>Table</TableHead>
          <TableHead>Confidence</TableHead>
          <TableHead>Filters</TableHead>
          <TableHead>Status</TableHead>
          {showReason && <TableHead>Reason</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {fields.map((f) => {
          const conf = f.confidence ?? 0.7;
          return (
            <TableRow key={f.id}>
              <TableCell>
                <code className="text-xs font-mono text-muted-foreground">
                  {f.id}
                </code>
              </TableCell>
              <TableCell className="text-sm">{f.label ?? '—'}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {f.table ?? '—'}
              </TableCell>
              <TableCell>
                <ConfidencePill value={conf} />
              </TableCell>
              <TableCell className="text-sm">
                {(f.filters ?? []).length}
              </TableCell>
              <TableCell>
                {f.flagged ? (
                  <Badge variant="destructive" className="text-xs">
                    Flagged
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-xs">
                    OK
                  </Badge>
                )}
              </TableCell>
              {showReason && (
                <TableCell className="text-xs text-muted-foreground max-w-xs truncate">
                  {f.flagReason ?? '—'}
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ConfidencePill({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    pct < 50
      ? 'bg-destructive/20 text-destructive'
      : pct < 70
        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
        : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  return (
    <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${color}`}>
      {pct}%
    </span>
  );
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="text-sm font-medium mb-3">{title}</h3>
      {children}
    </div>
  );
}
