import type { OSISemanticModel } from '../../../osi/types';
import type { AgentStateType } from '../state';

export async function assembleModelNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const {
    datasets,
    relationships,
    tableMetrics,
    modelMetrics,
    datasourceName,
    instructions,
  } = state;

  // Flatten all per-table metrics + model-level metrics
  const allMetrics = [...tableMetrics.flat(), ...modelMetrics];

  const semanticModel: OSISemanticModel = {
    semantic_model: [
      {
        name: datasourceName,
        description: `Semantic model for ${datasourceName} datasource`,
        ai_context: instructions
          ? {
              instructions,
              synonyms: [],
            }
          : undefined,
        datasets,
        relationships: relationships.length > 0 ? relationships : undefined,
        metrics: allMetrics.length > 0 ? allMetrics : undefined,
      },
    ],
  };

  return { semanticModel };
}
