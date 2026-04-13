import type {
  OSIDataset,
  OSIRelationship,
  OSISemanticModel,
} from '../../../osi/types';
import type { AgentStateType } from '../state';

function autoFix(model: OSISemanticModel): OSISemanticModel {
  const def = model.semantic_model[0];
  if (!def) return model;

  const datasetNames = new Set(def.datasets.map((d) => d.name));

  // Fix relationships that reference unknown datasets
  const validRelationships = (def.relationships ?? []).filter(
    (r: OSIRelationship) => datasetNames.has(r.from) && datasetNames.has(r.to),
  );

  // Ensure each dataset has required fields
  const fixedDatasets = def.datasets.map((d: OSIDataset) => ({
    ...d,
    name: d.name || `dataset_${d.source.replace(/\./g, '_')}`,
    fields: (d.fields ?? []).map((f) => ({
      ...f,
      expression: f.expression ?? {
        dialects: [{ dialect: 'ANSI_SQL', expression: f.name }],
      },
    })),
  }));

  return {
    semantic_model: [
      {
        ...def,
        datasets: fixedDatasets,
        relationships:
          validRelationships.length > 0 ? validRelationships : undefined,
      },
    ],
  };
}

export async function validateModelNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const { semanticModel } = state;
  if (!semanticModel) return {};

  const fixed = autoFix(semanticModel);
  return { semanticModel: fixed };
}
