import { HumanMessage } from '@langchain/core/messages';

import { getChatModel, extractJsonFromText } from '../../../llm';
import type {
  OSIMetric,
  OSIRelationship,
  RelationshipCandidate,
} from '../../../osi/types';
import type { AgentStateType } from '../state';

function buildPrompt(
  candidates: RelationshipCandidate[],
  datasetNames: string[],
  modelName: string,
): string {
  const candidateList = candidates
    .map(
      (c) =>
        `- ${c.fromDataset}.${c.fromColumns.join(',')} → ${c.toDataset}.${c.toColumns.join(',')} [${c.source}, confidence: ${c.confidence}]`,
    )
    .join('\n');

  return `You are a data modeling expert. Review these relationship candidates for the semantic model "${modelName}" and decide which to include.

Datasets in this model:
${datasetNames.join(', ')}

Relationship candidates:
${candidateList}

Return a JSON object with this exact structure:
{
  "relationships": [
    {
      "name": "<snake_case relationship name>",
      "from": "<child dataset name>",
      "to": "<parent dataset name>",
      "from_columns": ["<column>"],
      "to_columns": ["<column>"],
      "ai_context": {
        "description": "<what this relationship means in business terms>"
      }
    }
  ],
  "model_metrics": [
    {
      "name": "<cross_table metric name>",
      "expression": { "dialects": [{ "dialect": "ANSI_SQL", "expression": "<SQL using fully qualified schema.table.column>" }] },
      "description": "<what this cross-table metric measures>"
    }
  ]
}

Rules:
- Accept all high-confidence (explicit FK) candidates
- Accept low-confidence candidates only if they make business sense
- "from" is always the many/child side (has the FK column), "to" is the one/parent side
- Dataset names must exactly match one of the datasets listed above
- Return only valid JSON, no extra text`;
}

interface LlmRelationshipsOutput {
  relationships: OSIRelationship[];
  model_metrics?: OSIMetric[];
}

export async function generateRelationshipsNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const { relationshipCandidates, datasets, datasourceName } = state;

  if (relationshipCandidates.length === 0) {
    return { relationships: [], modelMetrics: [] };
  }

  const datasetNames = datasets.map((d) => d.name);
  const prompt = buildPrompt(
    relationshipCandidates,
    datasetNames,
    datasourceName,
  );

  try {
    const llm = getChatModel();
    const response = await llm.invoke([new HumanMessage(prompt)]);
    const text =
      typeof response.content === 'string'
        ? response.content
        : String(response.content);
    const parsed = extractJsonFromText(text) as LlmRelationshipsOutput;

    return {
      relationships: parsed.relationships ?? [],
      modelMetrics: parsed.model_metrics ?? [],
    };
  } catch {
    // If LLM fails, fall back to accepting all high-confidence candidates as-is
    const fallbackRelationships: OSIRelationship[] = relationshipCandidates
      .filter((c) => c.confidence === 'high')
      .map((c) => ({
        name: c.constraintName,
        from: c.fromDataset,
        to: c.toDataset,
        from_columns: c.fromColumns,
        to_columns: c.toColumns,
      }));

    return { relationships: fallbackRelationships, modelMetrics: [] };
  }
}
