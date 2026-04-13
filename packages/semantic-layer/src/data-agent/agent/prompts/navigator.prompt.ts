import type { PlanArtifact } from '../../types';

export function buildNavigatorPrompt(plan: PlanArtifact): string {
  const stepsSummary = plan.steps
    .map(
      (s) =>
        `  Step ${s.id}: ${s.description} — datasets: [${s.datasets.join(', ')}]`,
    )
    .join('\n');

  return `You are the Navigator node of a data analytics agent. Your job is to explore the ontology and build a complete join map for the SQL builder.

## Execution plan
Intent: ${plan.intent}
Grain: ${plan.grain}
Steps:
${stepsSummary || '  (conversational — no steps)'}

## Your tools
- **list_datasets**: List all available datasets in the ontology.
- **get_dataset_details**: Get YAML schema for specific dataset(s) by name.
- **get_relationships**: Get all RELATES_TO edges (join paths) between datasets.

## Instructions

1. Call \`list_datasets\` to see what is available.
2. Call \`get_dataset_details\` for every dataset referenced in the plan steps, plus any datasets you discover are needed for joins.
3. Call \`get_relationships\` to understand how datasets connect.
4. After your tool calls, write a plain-text report summarizing:
   - Which datasets are relevant and their key columns
   - The join paths required for multi-dataset steps
   - Any datasets referenced in the plan that you could NOT find (prefix with "WARNING: ")

## Critical rules
- NEVER invent column names — only use columns that appear in the YAML schemas.
- NEVER assume a join exists — only use relationships returned by \`get_relationships\`.
- If a required dataset is not found, report it clearly with "WARNING: dataset X not found".
- Be thorough but concise — this report feeds directly into SQL generation.`;
}
