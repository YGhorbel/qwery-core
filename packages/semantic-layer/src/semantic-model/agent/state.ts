import { Annotation } from '@langchain/langgraph';

import type { DiscoveredSchema } from '../../types';
import type {
  OSIDataset,
  OSIMetric,
  OSIRelationship,
  OSISemanticModel,
  RelationshipCandidate,
} from '../../osi/types';

export const AgentState = Annotation.Root({
  datasourceId: Annotation<string>,
  datasourceName: Annotation<string>,
  schema: Annotation<DiscoveredSchema>,
  driverId: Annotation<string>,
  config: Annotation<Record<string, unknown>>,
  instructions: Annotation<string | undefined>,

  // Accumulated across batch processing
  datasets: Annotation<OSIDataset[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  tableMetrics: Annotation<OSIMetric[][]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  failedTables: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),

  // Replaced by each node
  relationshipCandidates: Annotation<RelationshipCandidate[]>({
    value: (_old, next) => next,
    default: () => [],
  }),
  relationships: Annotation<OSIRelationship[]>({
    value: (_old, next) => next,
    default: () => [],
  }),
  modelMetrics: Annotation<OSIMetric[]>({
    value: (_old, next) => next,
    default: () => [],
  }),
  semanticModel: Annotation<OSISemanticModel | null>({
    value: (_old, next) => next,
    default: () => null,
  }),
  semanticModelId: Annotation<string | null>({
    value: (_old, next) => next,
    default: () => null,
  }),
});

export type AgentStateType = typeof AgentState.State;
