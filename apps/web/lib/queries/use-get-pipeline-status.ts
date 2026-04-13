import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@tanstack/react-query';
import { apiGet, apiPost } from '~/lib/repositories/api-client';

interface StageStatus {
  status:
    | 'not_started'
    | 'pending'
    | 'running'
    | 'indexing'
    | 'ready'
    | 'failed';
  updatedAt?: string;
  generatedAt?: string | null;
  error?: string | null;
}

export interface PipelineStatus {
  discovery: StageStatus;
  semanticModel: StageStatus;
  ontology: StageStatus;
}

function isRunning(status: StageStatus): boolean {
  return (
    status.status === 'running' ||
    status.status === 'indexing' ||
    status.status === 'pending'
  );
}

export function pipelineStatusKey(datasourceId: string | undefined) {
  return ['pipeline-status', datasourceId];
}

export function useGetPipelineStatus(datasourceId: string | undefined) {
  return useQuery({
    queryKey: pipelineStatusKey(datasourceId),
    queryFn: async (): Promise<PipelineStatus> => {
      const [discovery, semanticModel, ontology] = await Promise.all([
        apiGet<StageStatus>(
          `/datasources/${datasourceId}/discovery/status`,
          true,
        ),
        apiGet<StageStatus>(
          `/datasources/${datasourceId}/semantic-model/status`,
          true,
        ),
        apiGet<StageStatus>(`/datasources/${datasourceId}/ontology`, true),
      ]);
      return {
        discovery: discovery ?? { status: 'not_started' },
        semanticModel: semanticModel ?? { status: 'not_started' },
        ontology: ontology ?? { status: 'not_started' },
      };
    },
    enabled: !!datasourceId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 5_000;
      const anyRunning =
        isRunning(data.discovery) ||
        isRunning(data.semanticModel) ||
        isRunning(data.ontology);
      return anyRunning ? 3_000 : false;
    },
    staleTime: 0,
  });
}

export function useRebuildSemanticModel(datasourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiPost<{ status: string }>(
        `/datasources/${datasourceId}/semantic-model`,
        {},
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: pipelineStatusKey(datasourceId),
      });
    },
  });
}

export function useRebuildOntology(datasourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiPost<{ status: string }>(`/datasources/${datasourceId}/ontology`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: pipelineStatusKey(datasourceId),
      });
    },
  });
}
