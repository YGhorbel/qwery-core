import { useNavigate } from 'react-router';
import { useState, useRef } from 'react';
import {
  CheckCircle,
  XCircle,
  Loader2,
  Upload,
  Plus,
  Trash2,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@qwery/ui/button';
import { Input } from '@qwery/ui/input';
import { Badge } from '@qwery/ui/badge';
import { listRuns } from '~/lib/benchmark.server';
import { listDatasources } from '~/lib/storage.server';
import { BenchmarkTrend } from '~/components/charts/BenchmarkTrend';
import type { Route } from './+types/benchmark';
import type { BenchmarkRun, QuestionResult } from '~/lib/benchmark.server';
import type { DatasourceInfo } from '~/lib/storage.server';

export async function loader() {
  const [runs, datasources] = await Promise.all([listRuns(), listDatasources()]);
  return { runs, datasources };
}

type ProgressItem = {
  questionId: number;
  question: string;
  status: string;
  correct: boolean;
  f1: number | null;
  durationS: number;
};

export default function BenchmarkPage({ loaderData }: Route.ComponentProps) {
  const { runs, datasources } = loaderData;
  const navigate = useNavigate();

  const [questionsFile, setQuestionsFile] = useState<File | null>(null);
  const [workers, setWorkers] = useState(5);
  const [model, setModel] = useState('');
  const [mappings, setMappings] = useState<{ dbId: string; uuid: string }[]>([
    { dbId: '', uuid: '' },
  ]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressItem[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  async function handleRun() {
    if (!questionsFile) return;
    setRunning(true);
    setProgress([]);
    setError(null);

    const datasourceMap: Record<string, string> = {};
    for (const { dbId, uuid } of mappings) {
      if (dbId.trim() && uuid.trim()) datasourceMap[dbId.trim()] = uuid.trim();
    }

    const fd = new FormData();
    fd.append('questions', questionsFile);
    fd.append('datasource_map', JSON.stringify(datasourceMap));
    fd.append('workers', String(workers));
    if (model.trim()) fd.append('model', model.trim());

    try {
      const resp = await fetch('/benchmark/run', { method: 'POST', body: fd });
      if (!resp.ok) {
        setError(await resp.text());
        setRunning(false);
        return;
      }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let doneEvt: BenchmarkRun | null = null;
      const allResults: QuestionResult[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);

          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') break;

          try {
            const evt = JSON.parse(payload) as {
              type: string;
              current?: number;
              total?: number;
              result?: QuestionResult;
              summary?: BenchmarkRun['summary'];
              results?: QuestionResult[];
            };

            if (evt.type === 'progress' && evt.result) {
              const r = evt.result;
              allResults.push(r);
              if (evt.total) setTotal(evt.total);
              setProgress((prev) => {
                const item: ProgressItem = {
                  questionId: r.question_id,
                  question: r.question,
                  status: r.status,
                  correct: r.ex_strict,
                  f1: r.f1_score,
                  durationS: r.duration_ms / 1000,
                };
                const next = [...prev, item];
                setTimeout(
                  () =>
                    progressRef.current?.scrollTo({
                      top: progressRef.current.scrollHeight,
                      behavior: 'smooth',
                    }),
                  50,
                );
                return next;
              });
            } else if (evt.type === 'done' && evt.summary) {
              const ts = new Date()
                .toISOString()
                .replace(/[-:T.]/g, '')
                .slice(0, 15);
              doneEvt = {
                id: ts,
                timestamp: new Date().toISOString(),
                model: model.trim() || undefined,
                summary: evt.summary,
                results: evt.results ?? allResults,
              };
            }
          } catch {
            // non-JSON line
          }
        }
      }

      if (doneEvt) {
        await fetch('/benchmark/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(doneEvt),
        });
        navigate(`/benchmark/${doneEvt.id}`, { replace: false });
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
    }
  }

  const correct = progress.filter((p) => p.correct).length;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      <h1 className="text-xl font-semibold">Benchmark</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <h2 className="font-medium text-sm">Run a Benchmark</h2>

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Questions JSON file</span>
            <div className="flex items-center gap-2">
              <label className="cursor-pointer flex items-center gap-2 text-sm border rounded-md px-3 py-2 hover:bg-muted transition-colors">
                <Upload className="h-4 w-4" />
                {questionsFile ? questionsFile.name : 'Choose file…'}
                <input
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={(e) => setQuestionsFile(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>
          </label>

          <div className="space-y-2">
            <span className="text-xs text-muted-foreground">
              db_id → datasource UUID mapping
            </span>
            {mappings.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  placeholder="db_id"
                  value={m.dbId}
                  onChange={(e) =>
                    setMappings((prev) =>
                      prev.map((x, j) =>
                        j === i ? { ...x, dbId: e.target.value } : x,
                      ),
                    )
                  }
                  className="h-8 text-sm"
                />
                <span className="text-muted-foreground shrink-0">→</span>
                <DatasourceSelect
                  value={m.uuid}
                  datasources={datasources}
                  onChange={(uuid) =>
                    setMappings((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, uuid } : x)),
                    )
                  }
                />
                {mappings.length > 1 && (
                  <button
                    onClick={() =>
                      setMappings((prev) => prev.filter((_, j) => j !== i))
                    }
                    className="text-muted-foreground hover:text-destructive shrink-0"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={() =>
                setMappings((prev) => [...prev, { dbId: '', uuid: '' }])
              }
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <Plus className="h-3 w-3" /> Add mapping
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Workers</span>
              <Input
                type="number"
                min={1}
                max={20}
                value={workers}
                onChange={(e) => setWorkers(Number(e.target.value))}
                className="h-8 text-sm"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Model (optional)</span>
              <Input
                placeholder="default"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="h-8 text-sm"
              />
            </label>
          </div>

          {error && (
            <p className="text-sm text-destructive bg-destructive/10 rounded p-2">
              {error}
            </p>
          )}

          <Button
            onClick={handleRun}
            disabled={!questionsFile || running}
            className="w-full"
          >
            {running ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Running… {progress.length}/{total}
                {total > 0 && ` (${Math.round((correct / progress.length) * 100)}% EX)`}
              </>
            ) : (
              'Run Benchmark'
            )}
          </Button>
        </div>

        {running && (
          <div
            ref={progressRef}
            className="rounded-lg border bg-card p-4 space-y-1 overflow-y-auto max-h-80"
          >
            <h3 className="text-xs font-medium text-muted-foreground mb-2">
              Live Progress
            </h3>
            {progress.map((p) => (
              <div key={p.questionId} className="flex items-center gap-2 text-xs">
                {p.correct ? (
                  <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                )}
                <span className="truncate flex-1 text-muted-foreground">
                  {p.question}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {p.durationS.toFixed(1)}s
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {runs.length > 0 && (
        <div className="space-y-4">
          {runs.length >= 2 && (
            <div className="rounded-lg border bg-card p-4">
              <h3 className="text-sm font-medium mb-3">Score Trend</h3>
              <BenchmarkTrend runs={runs} />
            </div>
          )}

          <div className="rounded-lg border bg-card">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <h3 className="text-sm font-medium">Past Runs</h3>
              <span className="text-xs text-muted-foreground">{runs.length} run{runs.length !== 1 ? 's' : ''}</span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left px-4 py-2">Date</th>
                  <th className="text-left px-4 py-2">Model</th>
                  <th className="text-left px-4 py-2">Datasources</th>
                  <th className="text-right px-4 py-2">Questions</th>
                  <th className="text-right px-4 py-2">EX Strict</th>
                  <th className="text-right px-4 py-2">F1 Avg</th>
                  <th className="text-right px-4 py-2">Correct</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b last:border-0 hover:bg-muted/30"
                  >
                    <td className="px-4 py-2 text-muted-foreground text-xs">
                      {new Date(r.timestamp).toLocaleString('en', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                      {r.model ?? '—'}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        {r.datasourceIds.slice(0, 2).map((id) => (
                          <span
                            key={id}
                            className="font-mono text-xs bg-muted rounded px-1 py-0.5"
                            title={id}
                          >
                            {id.slice(0, 8)}
                          </span>
                        ))}
                        {r.datasourceIds.length > 2 && (
                          <span className="text-xs text-muted-foreground">
                            +{r.datasourceIds.length - 2}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right">{r.summary.total}</td>
                    <td className="px-4 py-2 text-right">
                      <Badge
                        variant={r.summary.ex_strict >= 0.7 ? 'default' : 'secondary'}
                        className="text-xs"
                      >
                        {(r.summary.ex_strict * 100).toFixed(1)}%
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-right text-muted-foreground">
                      {r.summary.f1_avg.toFixed(3)}
                    </td>
                    <td className="px-4 py-2 text-right text-muted-foreground">
                      {r.summary.correct}/{r.summary.total}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <a
                        href={`/benchmark/${r.id}`}
                        className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                      >
                        Details →
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function DatasourceSelect({
  value,
  datasources,
  onChange,
}: {
  value: string;
  datasources: DatasourceInfo[];
  onChange: (uuid: string) => void;
}) {
  return (
    <div className="relative flex-1 min-w-0">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-8 rounded-md border border-input bg-background px-3 pr-8 text-xs font-mono appearance-none focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <option value="">— select or type UUID —</option>
        {datasources.map((ds) => (
          <option key={ds.id} value={ds.id}>
            {ds.id.slice(0, 8)}… ({ds.measureCount}m {ds.dimensionCount}d {ds.ruleCount}r)
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
      {/* Allow manual override if not in list */}
      {value && !datasources.find((d) => d.id === value) && (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="UUID"
          className="mt-1 h-7 text-xs font-mono"
        />
      )}
    </div>
  );
}
