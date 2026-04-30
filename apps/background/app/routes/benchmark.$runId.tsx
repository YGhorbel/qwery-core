import { Link } from 'react-router';
import { useState, useCallback } from 'react';
import { ArrowLeft, CheckCircle, XCircle, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
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
import { getRun } from '~/lib/benchmark.server';
import type { QuestionResult } from '~/lib/benchmark.server';
import { BenchmarkByDifficulty } from '~/components/charts/BenchmarkByDifficulty';
import { StatusBreakdown } from '~/components/charts/StatusBreakdown';
import type { Route } from './+types/benchmark.$runId';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';

export async function loader({ params }: Route.LoaderArgs) {
  const run = await getRun(params.runId);
  return { run };
}

export default function RunDetailPage({ loaderData }: Route.ComponentProps) {
  const { run } = loaderData;
  const [filterDb, setFilterDb] = useState('');

  if (!run) {
    return (
      <div className="p-6">
        <Link to="/benchmark" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4 inline mr-2" />
          Back
        </Link>
        <p className="mt-4 text-muted-foreground">Run not found.</p>
      </div>
    );
  }

  const { summary, results } = run;
  const allDbIds = [...new Set(results.map((r) => r.db_id).filter(Boolean))].sort();

  const filtered = filterDb ? results.filter((r) => r.db_id === filterDb) : results;
  const correct = filtered.filter((r) => r.ex_strict);
  const failed = filtered.filter((r) => !r.ex_strict && r.status === 'evaluated');
  const noSql = filtered.filter((r) => r.status === 'no_prediction');

  const byDb = allDbIds.map((db) => {
    const rows = results.filter((r) => r.db_id === db);
    const n = rows.length;
    const ex = rows.filter((r) => r.ex_strict).length;
    return { db, n, ex, pct: n > 0 ? Math.round((ex / n) * 100) : 0 };
  });

  const durationData = results
    .filter((r) => r.duration_ms > 0)
    .map((r) => ({ s: Math.round(r.duration_ms / 1000) }));

  const durationBuckets: Record<number, number> = {};
  for (const { s } of durationData) {
    const b = Math.min(Math.floor(s / 10) * 10, 120);
    durationBuckets[b] = (durationBuckets[b] ?? 0) + 1;
  }
  const durationHist = Object.entries(durationBuckets)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([k, count]) => ({ range: `${k}–${Number(k) + 10}s`, count }));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link
          to="/benchmark"
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold">
          Run {new Date(run.timestamp).toLocaleString()}
        </h1>
        {run.model && (
          <Badge variant="outline" className="font-mono text-xs">
            {run.model}
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <StatCard label="Questions" value={summary.total} />
        <StatCard
          label="EX Strict"
          value={`${(summary.ex_strict * 100).toFixed(1)}%`}
          highlight
        />
        <StatCard
          label="F1 Avg"
          value={summary.f1_avg.toFixed(3)}
        />
        <StatCard
          label="No SQL"
          value={summary.no_sql}
          warn={summary.no_sql > 0}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-8">
        <div className="xl:col-span-2 rounded-lg border bg-card p-4">
          <h3 className="text-sm font-medium mb-3">Score by Difficulty</h3>
          <BenchmarkByDifficulty byDifficulty={summary.by_difficulty} />
        </div>
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <h3 className="text-sm font-medium mb-3">Status Breakdown</h3>
            <StatusBreakdown results={results} />
          </div>
          <div className="rounded-lg border bg-card p-4">
            <h3 className="text-sm font-medium mb-3">Duration Distribution</h3>
            {durationHist.length > 0 ? (
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={durationHist} margin={{ top: 4, right: 4, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="range" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                  <Tooltip formatter={(v) => [v, 'Questions']} />
                  <Bar dataKey="count" fill="var(--chart-3)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-xs text-muted-foreground">No duration data</p>
            )}
          </div>
        </div>
      </div>

      {allDbIds.length > 1 && (
        <div className="rounded-lg border bg-card mb-6 overflow-hidden">
          <div className="px-4 py-3 border-b">
            <h3 className="text-sm font-medium">Score by Database</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="text-left px-4 py-2">db_id</th>
                <th className="text-right px-4 py-2">Questions</th>
                <th className="text-right px-4 py-2">Correct</th>
                <th className="text-right px-4 py-2">EX Strict</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {byDb.map(({ db, n, ex, pct }) => (
                <tr
                  key={db}
                  className={`border-b last:border-0 hover:bg-muted/30 cursor-pointer ${filterDb === db ? 'bg-primary/5' : ''}`}
                  onClick={() => setFilterDb(filterDb === db ? '' : db)}
                >
                  <td className="px-4 py-2 font-mono text-xs">{db}</td>
                  <td className="px-4 py-2 text-right text-muted-foreground">{n}</td>
                  <td className="px-4 py-2 text-right text-muted-foreground">{ex}/{n}</td>
                  <td className="px-4 py-2 text-right">
                    <Badge variant={pct >= 70 ? 'default' : 'secondary'} className="text-xs">
                      {pct}%
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {filterDb === db && (
                      <span className="text-xs text-primary">filtered ✕</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Tabs defaultValue="failed">
        <div className="flex items-center justify-between mb-2">
          <TabsList>
            <TabsTrigger value="correct">
              Correct ({correct.length})
            </TabsTrigger>
            <TabsTrigger value="failed">
              Failed ({failed.length})
            </TabsTrigger>
            {noSql.length > 0 && (
              <TabsTrigger value="nosql">No SQL ({noSql.length})</TabsTrigger>
            )}
            <TabsTrigger value="all">All ({filtered.length})</TabsTrigger>
          </TabsList>

          {allDbIds.length > 1 && (
            <div className="relative">
              <select
                value={filterDb}
                onChange={(e) => setFilterDb(e.target.value)}
                className="h-8 rounded-md border border-input bg-background px-3 pr-7 text-xs font-mono appearance-none focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">All databases</option>
                {allDbIds.map((db) => (
                  <option key={db} value={db}>{db}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            </div>
          )}
        </div>

        <TabsContent value="correct" className="mt-4">
          <ResultTable results={correct} />
        </TabsContent>
        <TabsContent value="failed" className="mt-4">
          <ResultTable results={failed} showError />
        </TabsContent>
        {noSql.length > 0 && (
          <TabsContent value="nosql" className="mt-4">
            <ResultTable results={noSql} />
          </TabsContent>
        )}
        <TabsContent value="all" className="mt-4">
          <ResultTable results={filtered} showError />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight,
  warn,
}: {
  label: string;
  value: string | number;
  highlight?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border bg-card p-4 ${highlight ? 'border-primary/30 bg-primary/5' : ''} ${warn ? 'border-destructive/30 bg-destructive/5' : ''}`}
    >
      <div
        className={`text-2xl font-bold ${highlight ? 'text-primary' : ''} ${warn ? 'text-destructive' : ''}`}
      >
        {value}
      </div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

type TraceMessage = {
  id: string;
  role: string;
  content: unknown;
};

type TraceState = 'idle' | 'loading' | 'loaded' | 'error';

function TracePanel({ slug }: { slug: string }) {
  const [state, setState] = useState<TraceState>('idle');
  const [messages, setMessages] = useState<TraceMessage[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (state === 'loading' || state === 'loaded') return;
    setState('loading');
    try {
      const res = await fetch(`/api/trace?slug=${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as TraceMessage[];
      setMessages(Array.isArray(data) ? data : []);
      setState('loaded');
    } catch {
      setState('error');
    }
  }, [slug, state]);

  const toggle = () => {
    if (!open) void load();
    setOpen((v) => !v);
  };

  const toolResults = messages.flatMap((m) => {
    if (m.role !== 'tool') return [];
    const parts = (m as { content?: { type?: string; toolName?: string; result?: unknown }[] }).content;
    if (!Array.isArray(parts)) return [];
    return parts.filter((p) => p.type === 'tool-result' && (p.toolName === 'runQuery' || p.toolName === 'runQueries'));
  });

  return (
    <div>
      <button
        onClick={toggle}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Trace
      </button>
      {open && (
        <div className="mt-2 space-y-2 text-xs">
          {state === 'loading' && (
            <div className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </div>
          )}
          {state === 'error' && (
            <p className="text-destructive">Failed to load trace.</p>
          )}
          {state === 'loaded' && toolResults.length === 0 && (
            <p className="text-muted-foreground">No tool calls recorded.</p>
          )}
          {state === 'loaded' && toolResults.map((p, i) => {
            const result = p.result as Record<string, unknown> | null;
            const sql = typeof result?.sqlQuery === 'string' ? result.sqlQuery : null;
            const rows = Array.isArray(result?.rows) ? (result.rows as unknown[]).length : null;
            return (
              <div key={i} className="rounded border bg-muted/30 p-2 space-y-1">
                {sql && (
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all text-foreground">
                    {sql}
                  </pre>
                )}
                {rows !== null && (
                  <p className="text-muted-foreground">{rows} row{rows !== 1 ? 's' : ''} returned</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ResultTable({
  results,
  showError,
}: {
  results: QuestionResult[];
  showError?: boolean;
}) {
  return (
    <div className="rounded-lg border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">#</TableHead>
            <TableHead>Question</TableHead>
            <TableHead>DB</TableHead>
            <TableHead>Difficulty</TableHead>
            <TableHead>EX</TableHead>
            <TableHead>F1</TableHead>
            <TableHead>Time</TableHead>
            {showError && <TableHead>Error / SQL</TableHead>}
            <TableHead>History</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.map((r) => (
            <TableRow key={r.question_id} className="align-top">
              <TableCell className="text-xs text-muted-foreground pt-3">
                {r.question_id}
              </TableCell>
              <TableCell className="max-w-xs pt-3">
                <p className="truncate text-sm" title={r.question}>
                  {r.question}
                </p>
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap pt-3">
                {r.db_id ?? '—'}
              </TableCell>
              <TableCell className="pt-3">
                <Badge variant="outline" className="text-xs">
                  {r.difficulty}
                </Badge>
              </TableCell>
              <TableCell className="pt-3">
                {r.ex_strict ? (
                  <CheckCircle className="h-4 w-4 text-green-500" />
                ) : (
                  <XCircle className="h-4 w-4 text-destructive" />
                )}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground pt-3">
                {r.f1_score !== null ? r.f1_score.toFixed(2) : '—'}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground pt-3">
                {(r.duration_ms / 1000).toFixed(1)}s
              </TableCell>
              {showError && (
                <TableCell className="max-w-xs pt-3">
                  {r.error ? (
                    <p
                      className="text-xs text-destructive truncate"
                      title={r.error}
                    >
                      {r.error}
                    </p>
                  ) : r.predicted_sql ? (
                    <code
                      className="text-xs font-mono text-muted-foreground truncate block"
                      title={r.predicted_sql}
                    >
                      {r.predicted_sql.slice(0, 60)}…
                    </code>
                  ) : null}
                </TableCell>
              )}
              <TableCell className="pt-3">
                {r.conversation_slug ? (
                  <TracePanel slug={r.conversation_slug} />
                ) : (
                  <span className="text-xs text-muted-foreground/40">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
