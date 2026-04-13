import type { DatasetDetail } from '../../types';

export function buildPlannerPrompt(
  conversationContext: string,
  relevantDatasets: string[],
  relevantDatasetDetails: DatasetDetail[],
  clarificationRound: number,
): string {
  const datasetSection =
    relevantDatasetDetails.length > 0
      ? relevantDatasetDetails
          .map(
            (d) =>
              `### ${d.name} (${d.source})\n${d.description}\n\`\`\`yaml\n${d.yaml}\n\`\`\``,
          )
          .join('\n\n')
      : relevantDatasets.length > 0
        ? `Available datasets: ${relevantDatasets.join(', ')}`
        : 'No datasets pre-fetched — navigator will discover them.';

  const clarificationNote =
    clarificationRound >= 3
      ? '\n\nIMPORTANT: You have already asked for clarification multiple times. Do NOT ask again — make a reasonable assumption and proceed.'
      : clarificationRound > 0
        ? `\n\nNote: This is clarification round ${clarificationRound}. Only ask again if strictly necessary.`
        : '';

  return `You are the Planner node of a data analytics agent. Your job is to analyze the user's question and produce a structured execution plan.

## Conversation context
${conversationContext || '(no prior context)'}${clarificationNote}

## Pre-fetched relevant datasets
${datasetSection}

## Your task

Analyze the user question and output a JSON plan with these fields:

- **complexity**: One of:
  - \`simple\` — single dataset, straightforward aggregation or filter
  - \`analytical\` — multi-dataset joins, window functions, or multi-step logic
  - \`conversational\` — no data needed (e.g. "what datasets do you have?", greetings)

- **intent**: One sentence describing what the user wants.
- **metrics**: List of numeric measures the user wants (e.g. ["total revenue", "order count"]).
- **dimensions**: List of grouping/slicing dimensions (e.g. ["month", "product category"]).
- **timeWindow**: Time range if relevant (e.g. "last 30 days"), or null.
- **filters**: Any explicit filters mentioned.
- **grain**: The level of detail (e.g. "one row per customer per month").
- **steps**: Array of execution steps. Each step:
  - \`id\`: integer starting at 1
  - \`description\`: what this step computes
  - \`strategy\`: \`sql\` | \`python\` | \`sql_then_python\`
  - \`dependsOn\`: array of prior step IDs this step needs
  - \`datasets\`: dataset names this step queries
  - \`expectedOutput\`: what the result looks like
  - \`chartType\`: \`bar\` | \`line\` | \`pie\` | \`scatter\` | null (set ONLY if a chart is clearly appropriate)

- **acceptanceChecks**: 2–4 conditions that must hold for the answer to be correct (e.g. "sum of amounts equals total").
- **ambiguities**: Assumptions you made about ambiguous parts of the question.
- **shouldClarify**: true ONLY if the question is fundamentally unanswerable without more info.
- **clarificationQuestions**: max 3 questions (only if shouldClarify=true).
- **confidenceLevel**: \`high\` | \`medium\` | \`low\`.

## Rules

1. Prefer SQL over Python for aggregations and filters.
2. Use Python only for statistical analysis, complex transformations, or chart generation from data.
3. Set \`chartType\` only when the user explicitly asks for a chart/graph/visualization OR the data is clearly time-series or categorical distribution.
4. Ask for clarification ONLY if the question cannot be reasonably interpreted — not for minor ambiguities.
5. For conversational questions, set complexity=conversational, steps=[], shouldClarify=false.
6. Keep steps minimal — prefer one step unless multi-step is genuinely required.`;
}
