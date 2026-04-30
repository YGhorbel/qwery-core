import { Link } from 'react-router';
import { AlertTriangle, CheckCircle, Database, Layers } from 'lucide-react';
import { Badge } from '@qwery/ui/badge';
import { listDatasources } from '~/lib/storage.server';
import type { Route } from './+types/index';

export async function loader() {
  const datasources = await listDatasources();
  return { datasources };
}

export default function IndexPage({ loaderData }: Route.ComponentProps) {
  const { datasources } = loaderData;

  if (datasources.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <Database className="h-10 w-10 opacity-30" />
        <p className="text-sm">
          No datasources found in{' '}
          <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">
            QWERY_STORAGE_DIR
          </code>
        </p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-6">Databases</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {datasources.map((ds) => (
          <Link
            key={ds.id}
            to={`/datasources/${ds.id}`}
            className="block rounded-lg border bg-card p-5 hover:border-ring transition-colors group"
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-muted-foreground" />
                <span className="font-mono text-xs text-muted-foreground">
                  {ds.shortId}…
                </span>
              </div>
              <div className="flex gap-1">
                {ds.flaggedCount > 0 && (
                  <Badge variant="destructive" className="text-xs">
                    <AlertTriangle className="h-3 w-3 mr-1" />
                    {ds.flaggedCount}
                  </Badge>
                )}
                {ds.hasSemanticLayer && (
                  <Badge variant="secondary" className="text-xs">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    Layer
                  </Badge>
                )}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <StatBox label="Measures" value={ds.measureCount} />
              <StatBox label="Dimensions" value={ds.dimensionCount} />
              <StatBox label="Rules" value={ds.ruleCount} />
            </div>

            {ds.lowConfidenceCount > 0 && (
              <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
                {ds.lowConfidenceCount} field
                {ds.lowConfidenceCount > 1 ? 's' : ''} below 50% confidence
              </p>
            )}

            {ds.hasCandidates && (
              <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                <Layers className="h-3 w-3" />
                <span>Has measure candidates</span>
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-muted/50 rounded p-2">
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
