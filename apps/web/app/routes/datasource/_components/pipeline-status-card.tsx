import { Brain, Database, Loader2, Network, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@qwery/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qwery/ui/card';

import {
  useGetPipelineStatus,
  useRebuildOntology,
  useRebuildSemanticModel,
} from '~/lib/queries/use-get-pipeline-status';

interface Props {
  datasourceId: string;
}

type StageStatus =
  | 'not_started'
  | 'pending'
  | 'running'
  | 'indexing'
  | 'ready'
  | 'failed';

function StatusBadge({ status }: { status: StageStatus }) {
  const baseClass =
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium';

  if (status === 'ready') {
    return (
      <span
        className={`${baseClass} bg-green-500/15 text-green-600 dark:text-green-400`}
      >
        Ready
      </span>
    );
  }
  if (status === 'running' || status === 'indexing' || status === 'pending') {
    return (
      <span
        className={`${baseClass} bg-yellow-500/15 text-yellow-600 dark:text-yellow-400`}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        {status === 'pending' ? 'Pending' : 'Running'}
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className={`${baseClass} bg-destructive/15 text-destructive`}>
        Failed
      </span>
    );
  }
  return (
    <span className={`${baseClass} bg-muted text-muted-foreground`}>
      Not started
    </span>
  );
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return '';
  }
}

export function PipelineStatusCard({ datasourceId }: Props) {
  const { t } = useTranslation();
  const { data, isLoading } = useGetPipelineStatus(datasourceId);
  const rebuildSM = useRebuildSemanticModel(datasourceId);
  const rebuildOntology = useRebuildOntology(datasourceId);

  if (isLoading || !data) return null;

  const stages = [
    {
      key: 'discovery',
      label: t('datasource.pipeline.discovery', {
        defaultValue: 'Schema Discovery',
      }),
      icon: <Database className="text-muted-foreground h-4 w-4" />,
      status: data.discovery.status,
      time: data.discovery.updatedAt,
      error: data.discovery.error,
      action: null,
    },
    {
      key: 'semanticModel',
      label: t('datasource.pipeline.semanticModel', {
        defaultValue: 'Semantic Model',
      }),
      icon: <Brain className="text-muted-foreground h-4 w-4" />,
      status: data.semanticModel.status,
      time: data.semanticModel.generatedAt ?? data.semanticModel.updatedAt,
      error: data.semanticModel.error,
      action: (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={
            data.semanticModel.status === 'running' || rebuildSM.isPending
          }
          onClick={() => rebuildSM.mutate()}
          data-test="rebuild-semantic-model"
        >
          <RefreshCw
            className={`mr-1 h-3 w-3 ${rebuildSM.isPending ? 'animate-spin' : ''}`}
          />
          {t('datasource.pipeline.rebuild', { defaultValue: 'Rebuild' })}
        </Button>
      ),
    },
    {
      key: 'ontology',
      label: t('datasource.pipeline.ontology', {
        defaultValue: 'Ontology Index',
      }),
      icon: <Network className="text-muted-foreground h-4 w-4" />,
      status: data.ontology.status,
      time: data.ontology.updatedAt,
      error: data.ontology.error,
      action: (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={
            data.ontology.status === 'indexing' ||
            data.ontology.status === 'running' ||
            rebuildOntology.isPending
          }
          onClick={() => rebuildOntology.mutate()}
          data-test="rebuild-ontology"
        >
          <RefreshCw
            className={`mr-1 h-3 w-3 ${rebuildOntology.isPending ? 'animate-spin' : ''}`}
          />
          {t('datasource.pipeline.rebuild', { defaultValue: 'Rebuild' })}
        </Button>
      ),
    },
  ] as const;

  return (
    <Card className="mx-6 mt-4 mb-2">
      <CardHeader className="pt-4 pb-2">
        <CardTitle className="text-sm font-medium">
          {t('datasource.pipeline.title', { defaultValue: 'Pipeline Status' })}
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-4">
        <div className="space-y-2">
          {stages.map((stage) => (
            <div key={stage.key} className="flex items-center gap-3">
              {stage.icon}
              <span className="w-36 text-sm">{stage.label}</span>
              <StatusBadge status={stage.status as StageStatus} />
              {stage.time && (
                <span className="text-muted-foreground text-xs">
                  {formatTime(stage.time)}
                </span>
              )}
              {stage.error && (
                <span
                  className="text-destructive max-w-xs truncate text-xs"
                  title={stage.error}
                >
                  {stage.error}
                </span>
              )}
              <div className="ml-auto">{stage.action}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
