import { randomUUID } from 'crypto';

import { saveOsiModel } from '../../../schema-store';
import type { AgentStateType } from '../state';

export async function persistModelNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const { semanticModel, datasourceId } = state;
  if (!semanticModel) throw new Error('No semantic model to persist');

  const semanticModelId = randomUUID();
  await saveOsiModel(datasourceId, semanticModelId, semanticModel);

  return { semanticModelId };
}
